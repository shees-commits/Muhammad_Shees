import { createContainer } from './container.js';
import { ConfigError, loadConfig, type AppConfig } from './shared/config/env.js';
import { createApp } from './shared/http/app.js';

const SHUTDOWN_GRACE_MS = 10_000;

function bootstrap(): void {
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // The logger is not configured yet; write the (value-free) problems to stderr.
    // Set exitCode instead of calling process.exit() so piped stderr is flushed first.
    process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const container = createContainer(config);
  const { logger } = container;
  const app = createApp(container.appDeps);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'HTTP server listening');
  });
  container.startJobs();

  // Socket-level limits against slowloris-style clients that trickle headers or bodies.
  server.headersTimeout = 15_000;
  server.requestTimeout = config.http.requestTimeoutMs + 5_000;
  server.keepAliveTimeout = 5_000;

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    server.close((closeError) => {
      if (closeError) logger.error({ err: closeError }, 'Error while closing HTTP server');
      container
        .shutdown()
        .then(() => {
          logger.info('Shutdown complete');
          process.exit(closeError ? 1 : 0);
        })
        .catch((error: unknown) => {
          logger.error({ err: error }, 'Error during shutdown');
          process.exit(1);
        });
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    shutdown('SIGTERM');
  });
}

bootstrap();
