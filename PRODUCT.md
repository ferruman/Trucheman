# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the developer-owner, running the tool locally to translate DRM-free books for personal use. A future public release is possible, but the product is not intended to become a hosted service.

## Product Purpose

Trucheman turns a source ebook into a translated book while preserving a usable book file and making the translation workflow observable and recoverable. Success means completing the process locally—from upload and analysis through translation, editing, validation, and download—without relying on hosted application infrastructure.

## Positioning

A local-first translation tool that keeps job state and intermediate artifacts on the user's machine while sending only eligible text segments to a configured language provider.

## Operating Context

The application runs on the user's computer and is accessed through a local web interface. A typical workflow uploads a book, selects source and target languages, reviews the prepared job, starts translation, monitors progress, and downloads the validated result.

## Capabilities and Constraints

- The current supported input is DRM-free EPUB 2 or EPUB 3.
- Translation and editing can use separate provider profiles; a deterministic provider supports local testing without credentials.
- Jobs must support recovery, pausing, retrying, and rebuilding without corrupting source or intermediate data.
- Hosting the application as a public website is out of scope.
- Support for additional book formats is an open future direction, not a current commitment.

## Evidence on Hand

The repository contains a working React/Express application, automated unit, integration, contract, and end-to-end tests, and EPUB validation and safety controls. There are no public customer claims, testimonials, or usage metrics to present.

## Product Principles

- Keep the application genuinely local-first and straightforward to run on one machine.
- Preserve book structure and validate outputs instead of treating translation as plain-text conversion.
- Make long-running work inspectable, resumable, and resistant to partial failure.
- Minimize the content and secrets exposed outside the local environment.
- Leave room for additional formats without weakening the current EPUB workflow.
