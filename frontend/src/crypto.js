import CryptoJS from 'crypto-js';
import LZString from 'lz-string';

export function getHash(value) {
  return CryptoJS.SHA256('offlinenotepad' + value).toString().slice(0, 8);
}

function deriveKey(password, salt) {
  // Keep the original wire/storage format. CryptoJS 4.2 changed these defaults.
  return CryptoJS.PBKDF2(password, salt, {
    keySize: 128 / 32,
    iterations: 10,
    hasher: CryptoJS.algo.SHA1,
  });
}

export function encode(text, password) {
  const message = CryptoJS.enc.Utf16.parse(LZString.compressToUTF16(text));
  const salt = CryptoJS.lib.WordArray.random(16);
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(message, deriveKey(password, salt), {
    iv, padding: CryptoJS.pad.Pkcs7, mode: CryptoJS.mode.CBC,
  });
  return salt.toString() + iv.toString() + encrypted.toString();
}

export function decode(value, password) {
  if (typeof value !== 'string' || value.length < 64) return null;
  try {
    const salt = CryptoJS.enc.Hex.parse(value.slice(0, 32));
    const iv = CryptoJS.enc.Hex.parse(value.slice(32, 64));
    const decrypted = CryptoJS.AES.decrypt(value.slice(64), deriveKey(password, salt), {
      iv, padding: CryptoJS.pad.Pkcs7, mode: CryptoJS.mode.CBC,
    });
    return LZString.decompressFromUTF16(decrypted.toString(CryptoJS.enc.Utf16));
  } catch {
    return null;
  }
}
