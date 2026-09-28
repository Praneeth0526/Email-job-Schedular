import { Request } from 'express';
export type AuthRequest = Request & { userId?: string };
