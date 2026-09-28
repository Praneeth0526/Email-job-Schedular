import jwt from 'jsonwebtoken';
import { Response, NextFunction } from 'express';
import { env } from '../config/env.js';
import { AuthRequest } from '../types/auth.js';
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) { const token = req.cookies?.token; if (!token) return res.status(401).json({ error: 'Authentication required' }); try { req.userId = (jwt.verify(token, env.JWT_SECRET) as { userId: string }).userId; next(); } catch { res.status(401).json({ error: 'Invalid session' }); } }
