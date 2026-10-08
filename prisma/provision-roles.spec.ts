import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  RuntimeRoleContractError,
  passwordProblems,
  reportProvisioningFailure,
} from './provision-roles';

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

const SECRET = 'SENTINEL-postgresql://user:hunter2@db.internal/app';

describe('reportProvisioningFailure', () => {
  const report = (error: unknown): string => {
    const lines: string[] = [];
    reportProvisioningFailure(error, (line) => lines.push(line));
    return lines.join('\n');
  };

  it.each([
    [
      'an error with a secret in its message, name, stack and cause',
      () => {
        const error = new Error(`${SECRET} message`, { cause: new Error(SECRET) });
        error.name = 'SENTINEL_hunter2_Name';
        error.stack = `Error: ${SECRET}\n    at ${SECRET}`;
        return error;
      },
    ],
    ['a thrown string', () => SECRET],
    ['a thrown object', () => ({ message: SECRET, toString: () => SECRET })],
  ])('prints a fixed event and nothing from %s', (_label, make) => {
    const output = report(make());

    expect(JSON.parse(output)).toMatchObject({
      event: 'provision-roles.failed',
      errorCategory: expect.stringMatching(/^(internal|unknown)$/),
    });
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain('hunter2');
  });

  it('prints the message of an expected, operator-fixable problem in full', () => {
    const contract = new RuntimeRoleContractError([
      'commentbridge_api: is a member of role pg_read_all_data',
    ]);

    expect(report(contract)).toBe(contract.message);
    expect(report(contract)).toContain('pg_read_all_data');
    expect(report(contract)).toContain('Nothing was changed');
  });
});

/** The real command, with secrets planted everywhere an unsafe handler could print them. */
describe('db:provision-roles process output', () => {
  const root = join(__dirname, '..');
  const passwords = {
    COMMENTBRIDGE_API_DB_PASSWORD: 'SENTINEL-api-password-0123456789',
    COMMENTBRIDGE_WORKER_DB_PASSWORD: 'SENTINEL-worker-password-0123456789',
  };

  function run(env: Record<string, string>) {
    const result = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', 'prisma/provision-roles.ts'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 90_000,
        env: { ...process.env, MIGRATION_DATABASE_URL: '', ...passwords, ...env },
      },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('does not print the credentials of a database it cannot reach', () => {
    const { status, output } = run({
      MIGRATION_DATABASE_URL:
        'postgresql://SENTINEL_user:SENTINEL_hunter2@127.0.0.1:1/SENTINEL_db',
    });

    expect(status).toBe(1);
    expect(output).toContain('provision-roles.failed');
    expect(output).not.toContain('SENTINEL');
  }, 120_000);

  it('does not print a malformed connection string', () => {
    const { status, output } = run({
      MIGRATION_DATABASE_URL: 'SENTINEL not a url: hunter2',
    });

    expect(status).toBe(1);
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain('hunter2');
  }, 120_000);

  it('tells the operator which variable is missing', () => {
    const { status, output } = run({});

    expect(status).toBe(1);
    expect(output).toContain('MIGRATION_DATABASE_URL');
  }, 120_000);

  it('names a rejected password variable without printing the value', () => {
    const { status, output } = run({
      MIGRATION_DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/db',
      COMMENTBRIDGE_API_DB_PASSWORD: 'SENTINEL_short',
    });

    expect(status).toBe(1);
    expect(output).toContain('COMMENTBRIDGE_API_DB_PASSWORD');
    expect(output).not.toContain('SENTINEL');
  }, 120_000);
});
