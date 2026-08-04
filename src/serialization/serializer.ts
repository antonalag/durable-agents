import superjson from 'superjson';

superjson.registerCustom<Buffer, string>(
  {
    isApplicable: (v): v is Buffer => Buffer.isBuffer(v),
    serialize: (buf) => buf.toString('base64'),
    deserialize: (str) => Buffer.from(str, 'base64'),
  },
  'Buffer',
);

export function serialize(value: unknown): string {
  return superjson.stringify(value);
}

export function deserialize<T = unknown>(serialized: string): T {
  return superjson.parse(serialized) as T;
}
