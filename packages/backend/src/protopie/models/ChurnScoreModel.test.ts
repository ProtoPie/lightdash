import { escapeLikePattern } from './ChurnScoreModel';

describe('escapeLikePattern', () => {
    it('escapes LIKE wildcards so search is matched literally', () => {
        expect(escapeLikePattern('50%')).toBe('50\\%');
        expect(escapeLikePattern('a_b')).toBe('a\\_b');
        expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    });

    it('leaves ordinary text untouched', () => {
        expect(escapeLikePattern('acme corp')).toBe('acme corp');
    });

    it('escapes every wildcard occurrence', () => {
        expect(escapeLikePattern('%_%')).toBe('\\%\\_\\%');
    });
});
