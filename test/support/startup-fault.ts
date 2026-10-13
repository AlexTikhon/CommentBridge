/**
 * Preloaded (`node -r`) into a real API process to make one startup step fail with an
 * error that carries a synthetic secret in every property a logger might read. The
 * secret comes from FAULT_SECRET so a test can search the process output for it.
 *
 *   STARTUP_FAULT=init      the database connection fails while the application starts
 *   STARTUP_FAULT=listen    the HTTP server emits a hostile `error` event while binding
 *   STARTUP_FAULT=cleanup   `init`, and releasing the database then fails as well
 *   STARTUP_FAULT=port-free the connection succeeds, so only the real port can fail
 */
import 'reflect-metadata';
import { Server } from 'node:net';
import { PrismaService } from '../../src/database/prisma.service';

const secret = process.env.FAULT_SECRET ?? 'SENTINEL-unset';

function hostileError(): Error {
  const error = new Error(`${secret} message`, { cause: new Error(`${secret} cause`) });
  error.name = 'SENTINEL_hunter2_Name';
  error.stack = `Error: ${secret}\n    at ${secret}`;
  Object.assign(error, { code: secret, input: secret, toString: () => secret });
  return error;
}

const fault = process.env.STARTUP_FAULT;

if (fault === 'init' || fault === 'cleanup') {
  PrismaService.prototype.onModuleInit = () => Promise.reject(hostileError());
} else {
  PrismaService.prototype.onModuleInit = () => Promise.resolve();
}

if (fault === 'cleanup') {
  PrismaService.prototype.onApplicationShutdown = () => Promise.reject(hostileError());
}

if (fault === 'listen') {
  const server = Server.prototype as unknown as { listen: (this: Server) => Server };
  server.listen = function (this: Server): Server {
    setImmediate(() => this.emit('error', hostileError()));
    return this;
  };
}
