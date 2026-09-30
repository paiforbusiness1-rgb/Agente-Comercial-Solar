export const AppConfig = {
  get env() { return process.env.NODE_ENV || 'development'; },
  get port() { return parseInt(process.env.PORT || '3000', 10); },
  get tenant() {
    return {
      defaultId: process.env.TENANT_DEFAULT_ID || 'o3energy_mexico',
    };
  },
  get meta() {
    return {
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'O3_ENERGY_MEXICO_TOKEN',
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    };
  },
  get groq() {
    return {
      apiKey: process.env.GROQ_API_KEY || '',
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      temperature: parseFloat(process.env.GROQ_TEMPERATURE || '0.7'),
    };
  },
  get smtp() {
    return {
      server: process.env.SMTP_SERVER || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SENDER_EMAIL || 'alertas@o3energy.mx',
      pass: process.env.SENDER_PASSWORD || '',
      salesEmail: process.env.SALES_EMAIL || 'ventas@o3energy.mx',
    };
  },
  get mediaBaseUrl() {
    return process.env.MEDIA_BASE_URL || 'https://agente-comercial-solar.vercel.app/images';
  },
  get appUrl() {
    return process.env.APP_URL || 'https://agente-comercial-solar.vercel.app';
  },
  get auth() {
    return {
      adminEmail: process.env.ADMIN_EMAIL || 'admin@o3energy.mx',
      adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
      jwtSecret: process.env.JWT_SECRET || 'fallback-super-secret-jwt-key-minimum-32-chars-entropy-2026',
      tokenExpiresInHours: parseInt(process.env.JWT_EXPIRES_IN_HOURS || '8', 10),
    };
  }
};
