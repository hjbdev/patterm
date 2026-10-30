import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Seals a data key with the operating system's keyring. The desktop app passes
// Electron's safeStorage; the headless server has none.
export interface SecretKeyWrapper {
  available(): boolean;
  wrap(key: Buffer): Buffer;
  unwrap(sealed: Buffer): Buffer;
}

interface KeyFile {
  version: 1;
  wrapped: boolean;
  key: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Encrypts secret values with one AES-256-GCM data key kept beside, not in,
// the database. On the server the key file is only protected by its 0600
// mode, which keeps values out of database copies and backups but not from
// anyone who can read the data directory.
export class SecretVault {
  private key: Buffer | null = null;

  constructor(private readonly keyPath: string, private readonly wrapper: SecretKeyWrapper | null = null) {}

  get protectedByKeyring(): boolean {
    return this.read()?.wrapped ?? Boolean(this.wrapper?.available());
  }

  // The record ID is authenticated, so a ciphertext copied onto another
  // record fails to open.
  seal(recordId: string, plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.dataKey(), iv);
    cipher.setAAD(Buffer.from(recordId));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  open(recordId: string, sealed: Uint8Array): string {
    const data = Buffer.from(sealed);
    if (data.length < IV_BYTES + TAG_BYTES) throw new Error('Secret is unreadable');
    const decipher = createDecipheriv('aes-256-gcm', this.dataKey(), data.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(recordId));
    decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    try {
      return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Secret is unreadable. Its key may have changed; enter the secret again.');
    }
  }

  private dataKey(): Buffer {
    if (this.key) return this.key;
    const stored = this.read();
    if (stored) {
      const raw = Buffer.from(stored.key, 'base64');
      if (stored.wrapped && !this.wrapper?.available()) throw new Error('The system keyring that protects secrets is unavailable');
      this.key = stored.wrapped ? this.wrapper!.unwrap(raw) : raw;
      if (this.key.length !== KEY_BYTES) throw new Error('Secret key file is invalid');
      return this.key;
    }
    const key = randomBytes(KEY_BYTES);
    const wrapped = Boolean(this.wrapper?.available());
    const file: KeyFile = { version: 1, wrapped, key: (wrapped ? this.wrapper!.wrap(key) : key).toString('base64') };
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    // `wx` loses a race to another writer instead of replacing its key.
    try {
      fs.writeFileSync(this.keyPath, JSON.stringify(file), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return this.dataKey();
      throw error;
    }
    this.key = key;
    return key;
  }

  private read(): KeyFile | null {
    let text: string;
    try {
      text = fs.readFileSync(this.keyPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const file = JSON.parse(text) as Partial<KeyFile>;
    if (file.version !== 1 || typeof file.key !== 'string' || typeof file.wrapped !== 'boolean') throw new Error('Secret key file is invalid');
    return file as KeyFile;
  }
}
