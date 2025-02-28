package main

import (
	"context"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Config represents the structure of the JSON configuration file.
type Config struct {
	MaxConcurrency int      `json:"maxConcurrency"`
	Auth           S3Auth   `json:"auth"`
	Files          []S3File `json:"files"`
}

// S3Auth holds S3 authentication data.
type S3Auth struct {
	Method       string `json:"method"` // e.g. "explicit" or "default"
	AccessKey    string `json:"accessKey,omitempty"`
	SecretKey    string `json:"secretKey,omitempty"`
	SessionToken string `json:"sessionToken,omitempty"`
	Region       string `json:"region,omitempty"`
}

// S3File describes a file to download.
type S3File struct {
	S3Path     string `json:"s3Path"`
	Checksum   string `json:"checksum"`
	OutputPath string `json:"outputPath"`
}

// parseS3Path splits an S3 URL (s3://bucket/key) into its bucket and key.
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

// downloadAndValidate downloads an S3 object, writes it to disk, and validates its SHA‑512 checksum.
func downloadAndValidate(ctx context.Context, client *s3.Client, file S3File) error {
	bucket, key, err := parseS3Path(file.S3Path)
	if err != nil {
		return fmt.Errorf("failed to parse s3 path: %w", err)
	}

	// Request the object from S3.
	input := &s3.GetObjectInput{
		Bucket: &bucket,
		Key:    &key,
	}
	resp, err := client.GetObject(ctx, input)
	if err != nil {
		return fmt.Errorf("failed to get object from s3: %w", err)
	}
	defer resp.Body.Close()

	// Create (or overwrite) the output file.
	outFile, err := os.Create(file.OutputPath)
	if err != nil {
		return fmt.Errorf("failed to create output file: %w", err)
	}
	defer outFile.Close()

	// Set up the SHA‑512 hasher.
	hasher := sha512.New()

	// Write to both the file and the hasher concurrently.
	writer := io.MultiWriter(outFile, hasher)

	// Stream data from S3 to the file and hash it.
	if _, err := io.Copy(writer, resp.Body); err != nil {
		return fmt.Errorf("failed to download file: %w", err)
	}

	// Compare computed checksum with expected checksum.
	computedHash := hex.EncodeToString(hasher.Sum(nil))
	if computedHash != file.Checksum {
		defer os.Remove(file.OutputPath)
		return fmt.Errorf("checksum mismatch for %s: expected %s, got %s", file.S3Path, file.Checksum, computedHash)
	}

	log.Printf("Successfully downloaded and verified: %s", file.S3Path)
	return nil
}

func main() {
	// Retrieve the path to the config file from the command line.
	configPath := flag.String("config", "", "Path to JSON config file")
	flag.Parse()

	if *configPath == "" {
		log.Fatal("config file path is required")
	}

	// Open and decode the configuration file.
	file, err := os.Open(*configPath)
	if err != nil {
		log.Fatalf("failed to open config file: %v", err)
	}
	defer file.Close()

	var cfg Config
	if err := json.NewDecoder(file).Decode(&cfg); err != nil {
		log.Fatalf("failed to decode config: %v", err)
	}

	// Ensure a valid max concurrency value.
	if cfg.MaxConcurrency <= 0 {
		cfg.MaxConcurrency = 1
	}

	// Set up the AWS S3 client using the provided auth method.
	var awsCfg aws.Config
	ctx := context.TODO()
	if strings.ToLower(cfg.Auth.Method) == "explicit" {
		if cfg.Auth.Region == "" {
			log.Fatal("region is required for explicit auth")
		}
		// Use explicit credentials.
		awsCfg, err = config.LoadDefaultConfig(ctx,
			config.WithRegion(cfg.Auth.Region),
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.Auth.AccessKey, cfg.Auth.SecretKey, cfg.Auth.SessionToken)),
		)
		if err != nil {
			log.Fatalf("failed to load aws config: %v", err)
		}
	} else {
		// Use the default credentials chain.
		awsCfg, err = config.LoadDefaultConfig(ctx)
		if err != nil {
			log.Fatalf("failed to load aws config: %v", err)
		}
	}

	s3Client := s3.NewFromConfig(awsCfg)

	// Use a buffered channel as a semaphore to limit concurrency.
	sem := make(chan struct{}, cfg.MaxConcurrency)
	var wg sync.WaitGroup
	errCh := make(chan error, len(cfg.Files))

	// Launch a goroutine for each file download.
	for _, file := range cfg.Files {
		wg.Add(1)
		sem <- struct{}{} // acquire a slot
		go func(file S3File) {
			defer wg.Done()
			defer func() { <-sem }() // release the slot when done
			if err := downloadAndValidate(ctx, s3Client, file); err != nil {
				errCh <- err
			}
		}(file)
	}

	// Wait for all downloads to complete.
	wg.Wait()
	close(errCh)

	// Check for any errors.
	if len(errCh) > 0 {
		for err := range errCh {
			log.Printf("Error: %v", err)
		}
		log.Fatal("one or more downloads failed")
	}

	log.Println("All downloads completed successfully.")
}
