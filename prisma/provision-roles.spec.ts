import { passwordProblems } from './provision-roles';

const good = {
  COMMENTBRIDGE_API_DB_PASSWORD: 'a1b2c3d4e5f60718293a4b5c',
  COMMENTBRIDGE_WORKER_DB_PASSWORD: '0f9e8d7c6b5a49382716f5e4',
};

describe('passwordProblems', () => {
  it('accepts two distinct generated secrets', () => {
    expect(passwordProblems(good)).toEqual([]);
  });

  it('requires both passwords to be supplied', () => {
    expect(passwordProblems({})).toEqual([
      'COMMENTBRIDGE_API_DB_PASSWORD is not set',
      'COMMENTBRIDGE_WORKER_DB_PASSWORD is not set',
    ]);
  });

  it.each(['short', 'CHANGE_ME_CHANGE_ME_CHANGE', '<COMMENTBRIDGE_API_DB_PASSWORD>'])(
    'refuses the weak or placeholder password %p',
    (password) => {
      const problems = passwordProblems({
        ...good,
        COMMENTBRIDGE_API_DB_PASSWORD: password,
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        /COMMENTBRIDGE_API_DB_PASSWORD must be a generated secret/,
      );
      expect(problems[0]).not.toContain(password);
    },
  );

  it('refuses to give both roles the same password', () => {
    expect(
      passwordProblems({
        ...good,
        COMMENTBRIDGE_WORKER_DB_PASSWORD: good.COMMENTBRIDGE_API_DB_PASSWORD,
      }),
    ).toEqual([
      "COMMENTBRIDGE_WORKER_DB_PASSWORD must differ from the other role's password",
    ]);
  });
});
