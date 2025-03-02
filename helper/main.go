package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/gorilla/rpc"
	gorillajson "github.com/gorilla/rpc/json"
)

// S3Service provides RPC methods to download and upload files.
type S3Service struct {
	client      *s3.Client
	downloadSem chan struct{}
	uploadSem   chan struct{}
}

// DownloadRequest is the input for the Download method.
type DownloadRequest struct {
	S3Path      string `json:"s3Path"`     // e.g. "s3://bucket/key"
	OutputPath  string `json:"outputPath"` // local file path to save the object
	Checksum    string `json:"checksum"`   // expected SHA-512 checksum (hex encoded)
	ToUnarchive bool   `json:"toUnarchive"`
}

// DownloadResponse is the output from the Download method.
type DownloadResponse struct {
	Message string `json:"message"`
}

// UploadRequest is the input for the Upload method.
type UploadRequest struct {
	S3Path    string `json:"s3Path"`    // e.g. "s3://bucket/key"
	InputPath string `json:"inputPath"` // local file path to read from
	CreateTar bool   `json:"createTar"`
	Compress  bool   `json:"compress"`
}

// UploadResponse is the output from the Upload method.
type UploadResponse struct {
	Message string `json:"message"`
}
type PingRequest struct {
}

type PingResponse struct {
	Message string `json:"message"`
}

// parseS3Path splits an S3 URL (s3://bucket/key) into bucket and key.
func parseS3Path(s3Path string) (bucket, key string, err error) {
	if !strings.HasPrefix(s3Path, "s3://") {
		return "", "", fmt.Errorf("invalid s3 path: %s", s3Path)
	}
	withoutPrefix := strings.TrimPrefix(s3Path, "s3://")
	parts := strings.SplitN(withoutPrefix, "/", 2)
	if len(parts) < 2 {
		return "", "", fmt.Errorf("invalid s3 path, missing key: %s", s3Path)
	}
	return parts[0], parts[1], nil
}

// compressStream compresses the given io.Reader and returns an io.Reader for the compressed data.
func compressStream(reader io.Reader) io.Reader {
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		gw := gzip.NewWriter(pw)
		defer gw.Close()

		if _, err := io.Copy(gw, reader); err != nil {
			pw.CloseWithError(err)
			return
		}
	}()
	return pr
}

// createTarStream creates a tar stream from the specified directory.
func createTarStream(dirPath string) (io.Reader, error) {
	pr, pw := io.Pipe()
	go func() {
		tw := tar.NewWriter(pw)

		err := filepath.Walk(dirPath, func(file string, fi os.FileInfo, err error) error {
			if err != nil {
				return err
			}

			header, err := tar.FileInfoHeader(fi, fi.Name())
			if err != nil {
				return err
			}

			header.Name, err = filepath.Rel(dirPath, file)
			if err != nil {
				return err
			}

			if err := tw.WriteHeader(header); err != nil {
				return err
			}

			if !fi.Mode().IsRegular() {
				return nil
			}

			f, err := os.Open(file)
			if err != nil {
				return err
			}
			defer f.Close()

			if _, err := io.Copy(tw, f); err != nil {
				return err
			}

			return nil
		})

		tw.Close()
		pw.CloseWithError(err)
	}()

	return compressStream(pr), nil
}

// compressFile compresses the given file and returns an io.Reader for the compressed data.
func compressFile(filePath string) (io.Reader, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	return compressStream(file), nil
}

func (s *S3Service) Ping(r *http.Request, req *PingRequest, resp *PingResponse) error {
	resp.Message = "Pong"
	return nil
}

// Download downloads an object from S3, streams it to a file while computing its checksum,
// and returns an error if the computed checksum does not match the expected value.
func (s *S3Service) Download(r *http.Request, req *DownloadRequest, resp *DownloadResponse) error {
	// Acquire a download slot.
	s.downloadSem <- struct{}{}
	defer func() { <-s.downloadSem }()

	bucket, key, err := parseS3Path(req.S3Path)
	if err != nil {
		return err
	}

	ctx := context.Background()
	input := &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	}
	out, err := s.client.GetObject(ctx, input)
	if err != nil {
		return fmt.Errorf("failed to get object: %w", err)
	}
	defer out.Body.Close()

	// Create (or overwrite) the local file.
	file, err := os.Create(req.OutputPath)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer file.Close()

	// Set up a SHA‑512 hasher.
	hasher := sha512.New()

	// Use MultiWriter to write data to both the file and the hasher.
	writer := io.MultiWriter(file, hasher)
	if _, err := io.Copy(writer, out.Body); err != nil {
		return fmt.Errorf("failed to download file: %w", err)
	}

	computed := hex.EncodeToString(hasher.Sum(nil))
	if computed != req.Checksum {
		defer os.Remove(req.OutputPath)
		_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
		if err != nil {
			return fmt.Errorf("checksum mismatch: %s, expected %s, got %s, failed to delete object: %w", key, req.Checksum, computed, err)
		}
		return fmt.Errorf("checksum mismatch: %s, expected %s, got %s", key, req.Checksum, computed)
	}

	resp.Message = "Download successful"
	return nil
}

// Upload reads a local file and uploads its contents to the specified S3 location.
func (s *S3Service) Upload(r *http.Request, req *UploadRequest, resp *UploadResponse) error {
	// Acquire an upload slot.
	s.uploadSem <- struct{}{}
	defer func() { <-s.uploadSem }()

	bucket, key, err := parseS3Path(req.S3Path)
	if err != nil {
		return err
	}

	ctx := context.Background()

	headInput := &s3.HeadObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	}
	_, err = s.client.HeadObject(ctx, headInput)
	if err == nil {
		resp.Message = "Object already exists, skipping upload"
		return nil
	} else if !strings.Contains(err.Error(), "NotFound") {
		return fmt.Errorf("failed to check if object exists: %w", err)
	}
	var body io.Reader

	if req.CreateTar {
		tarStream, err := createTarStream(req.InputPath)
		if err != nil {
			return fmt.Errorf("failed to create tar.gz stream: %w", err)
		}
		body = tarStream
	} else {
		file, err := os.Open(req.InputPath)
		if err != nil {
			return fmt.Errorf("failed to open file: %w", err)
		}
		defer file.Close()
		body = file
	}

	if req.Compress {
		body = compressStream(body)
	}

	//todo // WARN Response has no supported checksum. Not validating response payload. add hash
	uploader := manager.NewUploader(s.client)
	input := &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   body,
	}
	_, err = uploader.Upload(ctx, input)
	if err != nil {
		return fmt.Errorf("failed to upload object: %w", err)
	}

	resp.Message = "Upload successful"
	return nil
}

// Config holds the configuration values passed via JSON string.
type Config struct {
	SocketPath             string `json:"socketPath"`
	MaxDownloadConcurrency int    `json:"maxDownloadConcurrency"`
	MaxUploadConcurrency   int    `json:"maxUploadConcurrency"`
	AWSRegion              string `json:"awsRegion"`
	AWSAccessKeyID         string `json:"awsAccessKeyId"`
	AWSSecretAccessKey     string `json:"awsSecretAccessKey"`
}

func main() {

	var cfg Config
	configData := os.Getenv("CONFIG")
	if configData == "" {
		log.Fatalf("CONFIG environment variable is not set")
	}

	if err := json.Unmarshal([]byte(configData), &cfg); err != nil {
		log.Fatalf("failed to parse configuration: %v", err)
	}

	if (cfg.MaxDownloadConcurrency <= 0) || (cfg.MaxUploadConcurrency <= 0) || (cfg.AWSRegion == "") || (cfg.AWSAccessKeyID == "") || (cfg.AWSSecretAccessKey == "") {
		log.Fatalf("invalid configuration")
	}

	ctx := context.Background()

	// Load AWS configuration using provided credentials and region.
	awsCfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(cfg.AWSRegion),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AWSAccessKeyID, cfg.AWSSecretAccessKey, "")),
	)
	if err != nil {
		log.Fatalf("failed to load AWS config: %v", err)
	}
	s3Client := s3.NewFromConfig(awsCfg)

	// Initialize our S3Service with the S3 client and concurrency limit semaphores.
	service := &S3Service{
		client:      s3Client,
		downloadSem: make(chan struct{}, cfg.MaxDownloadConcurrency),
		uploadSem:   make(chan struct{}, cfg.MaxUploadConcurrency),
	}

	// Set up the JSON-RPC server.
	s := rpc.NewServer()
	s.RegisterCodec(gorillajson.NewCodec(), "application/json")
	if err := s.RegisterService(service, "S3Service"); err != nil {
		log.Fatalf("failed to register service: %v", err)
	}

	// Use a Unix domain socket as our named pipe.
	os.Remove(cfg.SocketPath) // remove previous socket if exists
	l, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		log.Fatalf("failed to listen on unix socket: %v", err)
	}
	defer l.Close()

	http.Handle("/rpc", s)
	log.Printf("RPC server is listening on unix socket %s", cfg.SocketPath)
	log.Fatal(http.Serve(l, nil))
}
