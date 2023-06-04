package main

import (
	"archive/tar"
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/aws/request"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/s3"
)

var FILE_LIMIT = 400 * 1024 * 1024 // 400MB

func getFilesToUpload(dir string) {
	tarWriter := tar.NewWriter(os.Stdout)
	files, err := os.ReadDir(dir)
	if err != nil {
		panic(err)
	}
	for _, file := range files {
		if file.IsDir() {

		} else {
			fmt.Println(file.Name())

			tarWriter.WriteHeader()
			stat := os.Stat(dir + "/" + file.Name())

		}
	}
}

func uploadFiles() {

}

// Uploads a file to S3 given a bucket and object key. Also takes a duration
// value to terminate the update if it doesn't complete within that time.
//
// The AWS Region needs to be provided in the AWS shared config or on the
// environment variable as `AWS_REGION`. Credentials also must be provided
// Will default to shared config file, but can load from environment if provided.
//
// Usage:
//
//	# Upload myfile.txt to myBucket/myKey. Must complete within 10 minutes or will fail
//	go run withContext.go -b mybucket -k myKey -d 10m < myfile.txt
func main() {
	var bucket, key string
	var timeout time.Duration

	flag.StringVar(&bucket, "b", "", "Bucket name.")
	flag.StringVar(&key, "k", "", "Object key name.")
	flag.DurationVar(&timeout, "d", 0, "Upload timeout.")
	flag.Parse()

	sess := session.Must(session.NewSession())

	// Create a new instance of the service's client with a Session.
	// Optional aws.Config values can also be provided as variadic arguments
	// to the New function. This option allows you to provide service
	// specific configuration.
	svc := s3.New(sess)

	// Create a context with a timeout that will abort the upload if it takes
	// more than the passed in timeout.
	ctx := context.Background()
	var cancelFn func()
	if timeout > 0 {
		ctx, cancelFn = context.WithTimeout(ctx, timeout)
	}
	// Ensure the context is canceled to prevent leaking.
	// See context package for more information, https://golang.org/pkg/context/
	if cancelFn != nil {
		defer cancelFn()
	}

	// Uploads the object to S3. The Context will interrupt the request if the
	// timeout expires.
	_, err := svc.PutObjectWithContext(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   os.Stdin,
	})

	if err != nil {
		if aerr, ok := err.(awserr.Error); ok && aerr.Code() == request.CanceledErrorCode {
			// If the SDK can determine the request or retry delay was canceled
			// by a context the CanceledErrorCode error code will be returned.
			fmt.Fprintf(os.Stderr, "upload canceled due to timeout, %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "failed to upload object, %v\n", err)
		}
		os.Exit(1)
	}

	fmt.Printf("successfully uploaded file to %s/%s\n", bucket, key)
}
