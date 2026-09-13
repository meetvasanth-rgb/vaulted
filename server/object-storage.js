'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutBucketCorsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const SIGNED_URL_TTL_SECONDS = 10 * 60;

class EncryptedObjectStorage {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.endpoint = options.endpoint || env.OBJECT_STORAGE_ENDPOINT || env.AWS_ENDPOINT_URL || '';
    this.bucket = options.bucket || env.OBJECT_STORAGE_BUCKET || env.AWS_S3_BUCKET_NAME || '';
    this.region = options.region || env.OBJECT_STORAGE_REGION || env.AWS_DEFAULT_REGION || 'auto';
    this.accessKeyId = options.accessKeyId || env.OBJECT_STORAGE_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || '';
    this.secretAccessKey = options.secretAccessKey || env.OBJECT_STORAGE_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || '';
    this.urlStyle = options.urlStyle || env.OBJECT_STORAGE_URL_STYLE || env.AWS_S3_URL_STYLE || 'virtual';
    this.corsOrigins = String(options.corsOrigins ?? env.OBJECT_STORAGE_CORS_ORIGINS ?? '')
      .split(',').map(value => value.trim()).filter(Boolean);
    this.client = options.client || null;
    this.signer = options.signer || getSignedUrl;
    const configured = [this.endpoint, this.bucket, this.accessKeyId, this.secretAccessKey].filter(Boolean).length;
    if (configured > 0 && configured < 4) throw new Error('Object storage credentials are incomplete.');
    this.enabled = configured === 4;
    if (this.enabled && !this.client) {
      this.client = new S3Client({
        endpoint:this.endpoint,
        region:this.region,
        forcePathStyle:this.urlStyle === 'path',
        credentials:{ accessKeyId:this.accessKeyId, secretAccessKey:this.secretAccessKey },
      });
    }
  }

  async initialize() {
    if (!this.enabled) return false;
    if (this.corsOrigins.length) {
      await this.client.send(new PutBucketCorsCommand({
        Bucket:this.bucket,
        CORSConfiguration:{ CORSRules:[{
          AllowedOrigins:this.corsOrigins,
          AllowedMethods:['GET', 'PUT'],
          AllowedHeaders:['content-type'],
          ExposeHeaders:['etag'],
          MaxAgeSeconds:3600,
        }] },
      }));
    }
    return true;
  }

  async createUploadUrl(key) {
    const command = new PutObjectCommand({
      Bucket:this.bucket,
      Key:key,
      ContentType:'application/octet-stream',
    });
    return this.signer(this.client, command, { expiresIn:SIGNED_URL_TTL_SECONDS });
  }

  async createDownloadUrl(key) {
    const command = new GetObjectCommand({ Bucket:this.bucket, Key:key });
    return this.signer(this.client, command, { expiresIn:SIGNED_URL_TTL_SECONDS });
  }

  async sizeOf(key) {
    const result = await this.client.send(new HeadObjectCommand({ Bucket:this.bucket, Key:key }));
    return Number(result.ContentLength || 0);
  }

  async put(key, body) {
    await this.client.send(new PutObjectCommand({
      Bucket:this.bucket,
      Key:key,
      Body:body,
      ContentType:'application/octet-stream',
      CacheControl:'private, no-store',
    }));
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket:this.bucket, Key:key }));
  }

  close() { this.client?.destroy?.(); }
}

module.exports = { EncryptedObjectStorage, SIGNED_URL_TTL_SECONDS };
