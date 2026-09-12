import { describe, expect, it } from 'vitest';
import { AppError, isAppError, statusForCode } from './errors.js';

describe('AppError', () => {
  it('maps codes to HTTP statuses', () => {
    expect(statusForCode('validation_failed')).toBe(400);
    expect(statusForCode('unauthenticated')).toBe(401);
    expect(statusForCode('permission_denied')).toBe(403);
    expect(statusForCode('resource_not_found')).toBe(404);
    expect(statusForCode('rate_limited')).toBe(429);
    expect(statusForCode('internal_error')).toBe(500);
  });

  it('exposes its message except for internal errors', () => {
    expect(AppError.notFound('Widget').expose).toBe(true);
    expect(new AppError('internal_error', 'stack details').expose).toBe(false);
  });

  it('carries structured details', () => {
    const e = AppError.validation('Bad input', [{ path: 'name', issue: 'required' }]);
    expect(e.status).toBe(400);
    expect(e.details).toEqual([{ path: 'name', issue: 'required' }]);
  });

  it('is detectable with isAppError', () => {
    expect(isAppError(AppError.forbidden())).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });
});
