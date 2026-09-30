/**
 * scripts/generateAdminCredentials.ts
 * Security utility script to derive cryptographically secure scrypt password hashes
 * and 256-bit JWT secret keys without hardcoding plaintext passwords in repository.
 */

import crypto from 'crypto';

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return { salt, hash: `${salt}:${derivedKey.toString('hex')}` };
}

export function generateJwtSecret(): string {
  return crypto.randomBytes(32).toString('hex'); // 256-bit entropy
}

// Execution block for admin credential setup
if (process.argv[2]) {
  const pass = process.argv[2];
  const { hash } = hashPassword(pass);
  const jwtSecret = generateJwtSecret();

  console.log('===============================================================');
  console.log('🔒 CREDANCIALES CRIPTOGRÁFICAS GENERADAS CON ÉXITO');
  console.log('===============================================================\n');
  console.log(`ADMIN_EMAIL="admin@o3energy.mx"`);
  console.log(`ADMIN_PASSWORD_HASH="${hash}"`);
  console.log(`JWT_SECRET="${jwtSecret}"`);
  console.log('\nColoca estos valores en las variables de entorno de Vercel / .env');
  console.log('===============================================================');
}
