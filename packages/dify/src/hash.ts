import { createHash } from 'node:crypto';

/**
 * Content hash of a Dify DSL document. Used as the immutable version key for a
 * registered workflow — a re-import with the same text is a no-op, a changed
 * text yields a new hash (and a new resource version).
 */
export function dslHash(yamlText: string): string {
  return createHash('sha256').update(yamlText).digest('hex');
}
