---
phase: 3
slug: phase-03-videos
status: draft
subprojects:
  - nestjs-project
---

# Context — Phase 03: Upload e Processamento de Vídeos

## Scope

### Capabilities in Scope
- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

### Deliverables
- Upload de até 10GB funcional via multipart S3 presigned URLs.
- Processamento assíncrono em fila isolada (worker com FFmpeg/FFprobe).
- Streaming HTTP com suporte a Range requests (status 206).
- Download de arquivo completo.
- URLs e slugs únicos garantidos no banco de dados.

### Out of Scope (Deferred to Future Phases)
- Telas de upload e player no frontend (`next-frontend/` diferido para fases 4 e 5).
- Edição de títulos, descrições, tags e visibilidade pública/unlisted (Fase 04).
- Sistema de comentários, likes e contagem analítica de views (Fases 04 e 05).

---

## Decisions Index

| ID | Title | Scope | Choice |
| :--- | :--- | :--- | :--- |
| **TD-01** | Message Queue Technology and Architecture | Backend | **A: BullMQ + Redis via @nestjs/bullmq** |
| **TD-02** | 10GB File Upload and Storage Strategy | Backend | **A: Direct-to-Storage via S3 Presigned URLs / Multipart with @aws-sdk/client-s3** |
| **TD-03** | Video Worker Execution Model | Backend | **A: Standalone Worker Container in Docker Compose with FFmpeg/FFprobe** |
| **TD-04** | Unique Video Identifier and Public URL Strategy | Backend | **A: UUID primary key with unique public slug/URL** |
| **TD-05** | Video Streaming and User Download Strategy | Backend | **A: API Range 206 Streaming Proxy + Download Endpoint via @aws-sdk/client-s3** |
| **TD-06** | Video Lifecycle State Machine and Failure Handling | Backend | **State machine: DRAFT → UPLOADING → PROCESSING → READY \| FAILED** |

---

## Decisions Detail

### TD-01: Message Queue Technology and Architecture
- **Recommendation:** BullMQ + Redis via `@nestjs/bullmq`.
- **Libraries:** `@nestjs/bullmq`, `bullmq`, `ioredis` (connection driver). Redis service `redis:7-alpine` in `compose.yaml`.

### TD-02: 10GB File Upload and Storage Strategy
- **Recommendation:** Direct-to-Storage via S3 Presigned URLs / Multipart. Client requests upload initialization → API creates `Video` draft entity and starts multipart upload → client uploads parts to presigned URLs → client confirms completion → API completes multipart and dispatches job.
- **Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`. MinIO service in `compose.yaml`.

### TD-03: Video Worker Execution Model and Media Extraction
- **Recommendation:** Standalone NestJS worker process running in its own container with FFmpeg/FFprobe binaries, isolated from the HTTP API container. Reuses TypeORM entity definitions and database configuration cleanly.
- **Libraries:** `fluent-ffmpeg`, `@types/fluent-ffmpeg`, system FFmpeg in container.

### TD-04: Unique Video Identifier and Public URL Strategy
- **Recommendation:** PostgreSQL `uuid_generate_v4()` as primary key, paired with a unique, random collision-resistant slug for public URLs (e.g. 10-12 alphanumeric characters), verified against unique constraints with retry logic.
- **Libraries:** `nanoid` (or `crypto.randomBytes`).

### TD-05: Video Streaming and User Download Strategy
- **Recommendation:** API Range 206 streaming proxy for media playback with seeking support, plus dedicated download endpoint piping file stream with `Content-Disposition: attachment`.
- **Libraries:** `@aws-sdk/client-s3`.

### TD-06: Video Lifecycle State Machine and Failure Handling
- **Recommendation:** Linear status enum: `DRAFT`, `UPLOADING`, `PROCESSING`, `READY`, `FAILED`. BullMQ jobs retry 3 times with exponential backoff before transitioning to `FAILED` with error log.

---

## Inherited Conventions from Prior Phases

1. **Layer Separation:** Business logic exclusively inside services. Controllers handle routing, DTO validation, and response mapping.
2. **Error Handling:** Standardized `DomainExceptionFilter` with specific domain errors extending custom domain exceptions, never silent failure.
3. **Database & TypeORM:** Explicit TypeORM migrations; foreign key constraints; shared test DataSource with transaction/table isolation.
4. **Environment Variables:** Strict Joi validation in `ConfigModule.forRootAsync` using `registerAs()` namespaces.
5. **Testing Discipline:** Integration tests against real PostgreSQL/MinIO/Redis run with `--runInBand`; unit tests mock dependencies with zero unbound-method errors.
