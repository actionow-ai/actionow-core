import type { StorageProviderConfig } from '@actionow/contracts';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createS3StorageProvider, type S3StorageProvider } from '../src/storage.js';

const ROOT_USER = 'actionow';
const ROOT_PASSWORD = 'actionow123';
const BUCKET = 'actionow-test';

let container: StartedTestContainer;
let provider: S3StorageProvider;

beforeAll(async () => {
  // Real MinIO via Testcontainers (random host port — independent of compose).
  container = await new GenericContainer('minio/minio:latest')
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withEnvironment({ MINIO_ROOT_USER: ROOT_USER, MINIO_ROOT_PASSWORD: ROOT_PASSWORD })
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000).forStatusCode(200))
    .start();

  const endpoint = `http://${container.getHost()}:${String(container.getMappedPort(9000))}`;
  const cfg: StorageProviderConfig = {
    kind: 'minio',
    bucket: BUCKET,
    region: 'us-east-1',
    endpoint,
    accessKeyId: ROOT_USER,
    secretAccessKey: ROOT_PASSWORD,
    forcePathStyle: true,
  };
  provider = createS3StorageProvider(cfg);

  // Create the bucket up front using the provider's own client.
  await provider.client.send(new CreateBucketCommand({ Bucket: BUCKET }));
}, 120_000);

afterAll(async () => {
  await container.stop();
});

describe('S3 storage provider against real MinIO', () => {
  it('round-trips bytes: presign PUT -> upload -> head -> presign GET -> download', async () => {
    const key = 'tenant-acme/hello.txt';
    const body = new TextEncoder().encode('hello actionow object storage');
    const contentType = 'text/plain';

    // 1. presign PUT and upload the bytes over HTTP. Without the non-AWS
    //    checksum fix the v3.729+ default CRC makes MinIO reject this with 400.
    const put = await provider.presignPut(key, { contentType });
    expect(put.key).toBe(key);
    const putRes = await fetch(put.url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body,
    });
    expect(putRes.status).toBe(200);

    // 2. head() confirms the object exists with the uploaded size + an etag.
    const head = await provider.head(key);
    expect(head.exists).toBe(true);
    expect(head.size).toBe(body.byteLength);
    expect(head.etag).toBeTruthy();

    // 3. presign GET and download — bytes must match exactly.
    const get = await provider.presignGet(key);
    const getRes = await fetch(get.url);
    expect(getRes.status).toBe(200);
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    expect(downloaded).toEqual(body);
    expect(new TextDecoder().decode(downloaded)).toBe('hello actionow object storage');
  });

  it('head() reports a missing key as not existing', async () => {
    const head = await provider.head('tenant-acme/does-not-exist.bin');
    expect(head.exists).toBe(false);
    expect(head.size).toBeUndefined();
  });

  it('delete() removes an uploaded object', async () => {
    const key = 'tenant-acme/to-delete.txt';
    const body = new TextEncoder().encode('ephemeral');
    const put = await provider.presignPut(key, { contentType: 'text/plain' });
    const putRes = await fetch(put.url, { method: 'PUT', body });
    expect(putRes.status).toBe(200);
    expect((await provider.head(key)).exists).toBe(true);

    await provider.delete(key);
    expect((await provider.head(key)).exists).toBe(false);
  });
});
