import { assertDisposableRoleClusterUrl } from './role-cluster-test-utils';

const ROLES_URL =
  'postgresql://postgres:pw-sentinel@127.0.0.1:55436/commentbridge_roles_test';
const SHARED = {
  MIGRATION_DATABASE_URL: 'postgresql://postgres:pw@127.0.0.1:55433/commentbridge_test',
  DATABASE_URL: 'postgresql://commentbridge_api:pw@127.0.0.1:55433/commentbridge_test',
};

describe('assertDisposableRoleClusterUrl', () => {
  it('accepts a _test database on a cluster the other suites do not use', () => {
    expect(assertDisposableRoleClusterUrl(ROLES_URL, SHARED)).toBe(ROLES_URL);
  });

  it.each([
    ['unset', undefined],
    ['not a URL', 'not a url'],
    ['a database without the _test suffix', ROLES_URL.replace('_roles_test', '_roles')],
    ['the cluster the other suites use', ROLES_URL.replace('55436', '55433')],
  ])('refuses %s without echoing the URL', (_label, url) => {
    let message = '';
    try {
      assertDisposableRoleClusterUrl(url, SHARED);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Refusing to run the role-contract suite/);
    expect(message).not.toContain('pw-sentinel');
  });
});
