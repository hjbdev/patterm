#!/usr/bin/env node
// Verifies a minisign signature with Node's own Ed25519, so an installed
// Patterm can check an update without the minisign tool.
// Usage: verify-minisign.mjs <public key> <file> <file.minisig>
// The public key is the base64 line of a minisign .pub file.
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function decode(line, length, what) {
  const bytes = Buffer.from(line ?? '', 'base64');
  if (bytes.length !== length || bytes.toString('base64') !== line) throw new Error(`Malformed ${what}`);
  return bytes;
}

export function verifyMinisign(publicKey, contents, signatureText) {
  const key = decode(publicKey.trim(), 42, 'minisign public key');
  if (key.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('Unsupported minisign public key');
  const lines = signatureText.split('\n');
  const signature = decode(lines[1]?.trim(), 74, 'minisign signature');
  const trustedPrefix = 'trusted comment: ';
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[2]?.startsWith(trustedPrefix)) throw new Error('Malformed minisign signature');
  const trustedComment = lines[2].slice(trustedPrefix.length);
  const globalSignature = decode(lines[3]?.trim(), 64, 'minisign trusted comment signature');
  if (!signature.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error('The signature was made with a different key');
  const algorithm = signature.subarray(0, 2).toString('latin1');
  // "ED" signs a BLAKE2b-512 hash of the file, the default since minisign 0.11.
  const message = algorithm === 'ED' ? createHash('blake2b512').update(contents).digest()
    : algorithm === 'Ed' ? contents
    : null;
  if (!message) throw new Error('Unsupported minisign signature algorithm');
  const ed25519 = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.subarray(10).toString('base64url') }, format: 'jwk' });
  const fileSignature = signature.subarray(10);
  if (!verify(null, message, ed25519, fileSignature)) throw new Error('Signature verification failed');
  if (!verify(null, Buffer.concat([fileSignature, Buffer.from(trustedComment)]), ed25519, globalSignature)) throw new Error('Trusted comment verification failed');
  return trustedComment;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [publicKey, file, signature] = process.argv.slice(2);
  try {
    if (!publicKey || !file || !signature) throw new Error(`Usage: ${path.basename(process.argv[1])} <public key> <file> <file.minisig>`);
    console.log(`Signature verified: ${verifyMinisign(publicKey, fs.readFileSync(file), fs.readFileSync(signature, 'utf8'))}`);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
