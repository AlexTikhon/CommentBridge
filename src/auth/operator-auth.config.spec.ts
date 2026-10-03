import {
  InvalidOperatorAuthConfigError,
  loadOperatorAuthConfig,
} from './operator-auth.config';

const keyA = 'a'.repeat(32);
const keyB = 'b'.repeat(40);

describe('loadOperatorAuthConfig', () => {
  it('has no credentials when nothing is configured', () => {
    expect(loadOperatorAuthConfig({}).credentials).toEqual([]);
    expect(loadOperatorAuthConfig({ OPERATOR_API_KEYS: '  ' }).credentials).toEqual([]);
  });

  it('parses operator=key pairs and stores only digests', () => {
    const { credentials } = loadOperatorAuthConfig({
      OPERATOR_API_KEYS: `alice@example.com=${keyA}, bob=${keyB}`,
    });

    expect(credentials.map(({ operatorId }) => operatorId)).toEqual([
      'alice@example.com',
      'bob',
    ]);
    expect(credentials[0]?.keyDigest).toHaveLength(32);
    expect(JSON.stringify(credentials)).not.toContain(keyA);
  });

  it('keeps trailing "=" characters that belong to the key', () => {
    const key = `${'c'.repeat(31)}==`;
    const [credential] = loadOperatorAuthConfig({
      OPERATOR_API_KEYS: `carol=${key}`,
    }).credentials;

    expect(credential?.operatorId).toBe('carol');
  });

  it.each([
    ['missing separator', `alice${keyA}`],
    ['empty operator', `=${keyA}`],
    ['key shorter than 32 characters', 'alice=short-key'],
    ['operator containing whitespace', `ali ce=${keyA}`],
    ['duplicate operator', `alice=${keyA},alice=${keyB}`],
    ['duplicate key', `alice=${keyA},bob=${keyA}`],
    ['empty entry', `alice=${keyA},,bob=${keyB}`],
  ])('rejects %s', (_label, value) => {
    expect(() => loadOperatorAuthConfig({ OPERATOR_API_KEYS: value })).toThrow(
      InvalidOperatorAuthConfigError,
    );
  });

  it('never echoes a key value in its error', () => {
    let message = '';
    try {
      loadOperatorAuthConfig({ OPERATOR_API_KEYS: 'alice=hunter2' });
    } catch (error: unknown) {
      message = (error as Error).message;
    }

    expect(message).toContain('OPERATOR_API_KEYS');
    expect(message).not.toContain('hunter2');
  });
});
