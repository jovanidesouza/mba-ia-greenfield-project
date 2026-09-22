---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-04-08
scope_description: "Backend video upload, processing, storage, and streaming foundation: S3/MinIO storage service, BullMQ/Redis queue, standalone video worker with FFmpeg/FFprobe, unique slug/URL generation, Range 206 HTTP streaming, and video lifecycle status state machine."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers video upload orchestration, metadata extraction, background worker, object storage integration (MinIO/S3), HTTP Range streaming, and video download.
- `next-frontend/` — Frontend deferred: video player screen, upload UI and channel management are not part of this phase (planned for later phases).

---

## TD-01: Message Queue Technology and Architecture

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (duration extraction, metadata, thumbnail generation via FFmpeg) is CPU and I/O intensive. It cannot execute in the main HTTP request-response cycle. An asynchronous message queue is required to decouple the upload notification from video transcode/inspection jobs, with support for retries, failure handling, and concurrency limits.

**Options:**

### Option A: BullMQ + Redis (@nestjs/bullmq)
- Distributed queue system for Node.js based on Redis streams/hashes. First-class NestJS integration via `@nestjs/bullmq` and `bullmq`.
- **Pros:** Native TypeScript/Node.js ecosystem, extremely fast, robust retry and backoff strategies, stalled job detection, parent/child job flows, dead-letter capability, and active maintenance. Docker footprint is minimal (`redis:7-alpine` ~30MB RAM). Clean NestJS integration (`@Processor()`, `WorkerHost`).
- **Cons:** Requires adding a Redis service to Docker Compose. Redis is primarily in-memory (though persistent with AOF/RDB).

### Option B: RabbitMQ (amqplib / @golevelup/nestjs-rabbitmq)
- Traditional AMQP message broker with exchanges, routing keys, and queues.
- **Pros:** Robust protocol, highly durable message broker, enterprise-proven, complex routing topologies.
- **Cons:** Significantly higher memory footprint in Docker (Erlang VM ~150-200MB baseline). Steeper configuration learning curve. NestJS integrations are community-maintained rather than core/official recipes.

### Option C: PostgreSQL-based queue (pg-boss or transactional table)
- Use PostgreSQL tables with `SKIP LOCKED` or `pg-boss` to queue jobs.
- **Pros:** Zero new infrastructure (reuses the existing PostgreSQL database).
- **Cons:** Long-running processing jobs and polling can increase contention on the operational database. Lacks advanced worker orchestration and rate-limiting features natively optimized for media workloads.

**Recommendation:** **Option A (BullMQ + Redis)** — Standard in the modern Node.js/NestJS ecosystem, officially supported via `@nestjs/bullmq`, lightweight in local Docker (`redis:7-alpine`), and provides out-of-the-box job status, retry, and progress tracking ideal for video processing pipelines.

**Decision:** **A (BullMQ + Redis via @nestjs/bullmq)**

---

## TD-02: 10GB File Upload and Storage Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance / Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The platform requires supporting video uploads of up to 10GB without blocking or degrading API performance. Streaming large files directly through the Node.js API server would consume substantial memory, network sockets, and CPU in the web process. The object storage is S3-compatible (MinIO in local development).

**Options:**

### Option A: Direct-to-Storage Upload via Presigned S3 URLs (Multipart Upload)
- The client requests an upload from the API. The API creates a Video entity in `DRAFT` status and initiates an S3 Multipart Upload via `@aws-sdk/client-s3`, returning presigned URLs for each part (or presigned PUT for smaller files). The client uploads parts directly to MinIO/S3. When finished, the client notifies the API via `POST /videos/:id/complete-upload` (or S3 bucket event), which calls `CompleteMultipartUpload` and enqueues the processing job.
- **Pros:** Zero file bytes pass through the NestJS API server. Zero API memory overhead during 10GB uploads. Highly resilient to network drops (parts can be retried individually). Fully scalable.
- **Cons:** Requires client coordination (uploading parts to presigned URLs and notifying completion).

### Option B: API Proxy Streaming (Multer / Busboy into S3)
- Client streams the file directly to the NestJS API via `multipart/form-data`, which streams chunks to S3 via Passthrough/Upload stream.
- **Pros:** Simpler client interface (single standard HTTP POST).
- **Cons:** 10GB stream saturates API network bandwidth and keeps Node.js event-loop I/O handles open for minutes to hours. A server restart or timeout fails the entire multi-gigabyte upload.

**Recommendation:** **Option A (Direct-to-Storage via S3 Presigned URLs / Multipart)** — This is the only architecture that satisfies the requirement "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" in production and development.

**Decision:** **A (Direct-to-Storage via Presigned URLs / Multipart with @aws-sdk/client-s3)**

---

## TD-03: Video Worker Execution Model and Media Extraction

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas) / Processamento automático do vídeo / Geração automática de thumbnail

**Context:** When a video upload completes, a background worker must inspect the file (duration, width, height, codec, bitrate) and extract a representative thumbnail image from a video frame. The execution model and toolchain must be determined.

**Options:**

### Option A: Standalone NestJS Worker Container using fluent-ffmpeg / ffmpeg-static
- A dedicated Docker container running a NestJS standalone app (`src/video-worker/main.ts` or standalone entry point) consuming BullMQ jobs, with FFmpeg/FFprobe binaries installed in the Alpine/Debian image.
- **Pros:** Full access to NestJS TypeORM entities, repositories, and config namespaces. Complete CPU and memory isolation from the HTTP API container — a CPU-pegging transcode or probe cannot degrade HTTP request latencies.
- **Cons:** Requires a separate service definition in `compose.yaml`.

### Option B: In-Process Worker inside the main NestJS API container
- Register `@Processor('video-processing')` inside the same NestJS HTTP server process.
- **Pros:** Single container, simpler Compose file.
- **Cons:** Heavy FFmpeg execution directly robs CPU cycles and thread pool bandwidth from the HTTP API handling user requests. Violates the requirement to avoid impacting API performance.

**Recommendation:** **Option A (Standalone NestJS Worker Container with FFmpeg/FFprobe)** — Shares domain entities, migrations, and database configs cleanly while providing absolute process and resource isolation in Docker.

**Decision:** **A (Standalone Worker Container in Docker Compose with FFmpeg/FFprobe)**

---

## TD-04: Unique Video Identifier and Public URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos / Pré-cadastro automático do vídeo como rascunho

**Context:** Every video must have a unique, non-conflicting identifier and public URL. The system needs to ensure uniqueness without race conditions and follow established project patterns (similar to `nickname.util.ts` for channels).

**Options:**

### Option A: UUIDv4 as Primary Identifier + Canonical NanoID / Slug for Public URLs
- Primary database key is `UUID` (consistent with `User`, `Channel`, and tokens). Public video access uses a unique short slug or canonical NanoID/UUID that is verified against unique DB constraints.
- **Pros:** Matches existing database conventions (PostgreSQL `uuid_generate_v4()`). Cryptographically random, collision probability is effectively zero, unguessable for private/unlisted videos.
- **Cons:** UUIDs are 36 characters long if used directly in URLs, though URL-safe slugs can be generated.

### Option B: Auto-incrementing numeric IDs
- Sequential IDs (1, 2, 3...).
- **Pros:** Short URLs (`/videos/1`).
- **Cons:** Trivial enumeration attack (competitors can count total platform uploads, scrape all videos), leaks upload frequency.

**Recommendation:** **Option A (UUID primary key with collision-resistant URL slug)** — Conforms to existing entity ID conventions (`User`, `Channel`) while guaranteeing global uniqueness without collisions.

**Decision:** **A (UUID primary key with unique public slug/URL)**

---

## TD-05: Video Streaming and User Download Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo) / Download do vídeo pelo usuário

**Context:** Users need to play videos without waiting for the full file to download (streaming), and download the full file on demand. The architecture must support HTTP Range requests (`bytes=start-end`, returning status `206 Partial Content`) for instant playback seeking.

**Options:**

### Option A: API Streaming Proxy with HTTP Range (206) Support + S3 GetObject Command
- Client requests `GET /videos/:id/stream` with `Range` headers. The API queries S3 (`GetObjectCommand` with `Range`) and pipes the chunk to the client with `206 Partial Content`, `Content-Range`, and `Accept-Ranges: bytes`. For download, `GET /videos/:id/download` streams with `Content-Disposition: attachment`.
- **Pros:** API enforces access control, view logging, and visibility rules on every request. Hides MinIO/S3 internal bucket architecture from public clients. Works seamlessly in local Docker without configuring CORS or presigned domain routing for MinIO.
- **Cons:** Chunks pass through the API stream (minimal overhead when piped as stream buffers).

### Option B: Direct Presigned GET redirect to Object Storage
- API responds with a `302 Found` redirecting to a presigned S3 GET URL.
- **Pros:** Offloads streaming bandwidth entirely to S3.
- **Cons:** In local Docker, MinIO presigned URLs generated with `minio:9000` (internal host) are unreachable from the user's host browser unless complex dual-endpoint / DNS mapping is set up.

**Recommendation:** **Option A (API Range 206 Streaming Proxy + Download Endpoint)** — Enforces authorization/unlisted visibility checks, enables future view-counting hooks, and provides zero-friction streaming in both local Docker and production environments.

**Decision:** **A (API Range 206 Streaming Proxy + Download Endpoint via @aws-sdk/client-s3)**

---

## TD-06: Video Lifecycle State Machine and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload / Processamento automático do vídeo

**Context:** A video undergoes multiple lifecycle transitions: draft creation, upload in progress, upload completed, processing (extracting metadata and thumbnail), ready for playback, or failed. A clear state machine ensures consistency and idempotent handling.

**State Transitions:**
1. `DRAFT`: Video metadata registered, presigned upload URLs issued to client.
2. `UPLOADING`: Upload in progress by the client.
3. `PROCESSING`: Client signaled upload completion, job queued in BullMQ, worker probing and generating thumbnail.
4. `READY`: Processing succeeded, duration and thumbnail URL populated, playable.
5. `FAILED`: Upload aborted, processing error, or invalid media file.

**Failure & Retry Policy:**
- BullMQ jobs configured with 3 retries and exponential backoff (e.g. 5s, 15s, 45s).
- If retries are exhausted, the job moves to failed, and video status transitions to `FAILED` with an error message stored in the database.

**Decision:** **State machine with statuses `DRAFT` → `UPLOADING` → `PROCESSING` → `READY` | `FAILED`, with BullMQ 3-attempt exponential retry.**
