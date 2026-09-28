import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'), PORT: z.coerce.number().default(4000), FRONTEND_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string(), REDIS_URL: z.string().default('redis://localhost:6379'), ELASTICSEARCH_URL: z.string().default('http://localhost:9200'), JWT_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().optional(), GOOGLE_CLIENT_SECRET: z.string().optional(), GOOGLE_CALLBACK_URL: z.string().default('http://localhost:4000/api/auth/google/callback'),
  SLACK_CLIENT_ID: z.string().optional(), SLACK_CLIENT_SECRET: z.string().optional(), SLACK_REDIRECT_URI: z.string().default('http://localhost:4000/api/slack/callback'),
  WORKER_CONCURRENCY: z.coerce.number().default(5), MIN_DELAY_BETWEEN_EMAILS_MS: z.coerce.number().default(2000), MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().default(100), RETRY_ATTEMPTS: z.coerce.number().default(3), RETRY_BACKOFF_MS: z.coerce.number().default(5000)
});
export const env = schema.parse(process.env);
