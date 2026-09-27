import { gunzipSync } from 'zlib';
import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';

/** Just enough of S3 for Store: get, conditional put, list. */
export class FakeS3 {
    objects = new Map<string, { body: Buffer; etag: string }>();
    puts: string[] = [];
    private version = 0;

    async send(command: unknown): Promise<unknown> {
        if (command instanceof GetObjectCommand) {
            const obj = this.objects.get(command.input.Key!);
            if (!obj) throw new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
            return { ETag: obj.etag, Body: { transformToByteArray: async () => new Uint8Array(obj.body) } };
        }
        if (command instanceof PutObjectCommand) {
            const { Key, Body, IfMatch, IfNoneMatch } = command.input;
            const existing = this.objects.get(Key!);
            if ((IfMatch && existing?.etag !== IfMatch) || (IfNoneMatch === '*' && existing)) {
                throw new S3ServiceException({ name: 'PreconditionFailed', $fault: 'client', $metadata: { httpStatusCode: 412 } });
            }
            this.objects.set(Key!, { body: Buffer.from(Body as Buffer | string), etag: `"${++this.version}"` });
            this.puts.push(Key!);
            return {};
        }
        if (command instanceof ListObjectsV2Command) {
            const prefix = command.input.Prefix ?? '';
            return { Contents: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((Key) => ({ Key })) };
        }
        throw new Error(`FakeS3 does not support ${(command as object).constructor.name}`);
    }

    asClient = () => this as unknown as S3Client;

    text(key: string) {
        const body = this.objects.get(key)!.body;
        return (body[0] === 0x1f ? gunzipSync(body) : body).toString('utf8');
    }

    json<T>(key: string): T {
        return JSON.parse(this.text(key));
    }
}
