import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
export function Button({ children, variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) { return <button className={`button button-${variant}`} {...props}>{children}</button>; }
export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className="field" {...props} />; }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className="field textarea" {...props} />; }
export function Badge({ children, status }: { children: ReactNode; status?: string }) { return <span className={`badge badge-${status ?? 'default'}`}>{children}</span>; }
export function Spinner() { return <span className="spinner" aria-label="Loading" />; }
export function Skeleton() { return <div className="skeleton" />; }