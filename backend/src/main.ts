import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter, NestExpressApplication } from '@nestjs/platform-express';
import { environment } from './config/environment';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { log } from './common/logger';
import { ServerOptions } from 'socket.io';
import * as express from 'express';  // Explicitly import express
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AIProviderService } from './analysis/ai-provider.service';

class ExtendedIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      path: environment.socket.path,
      cors: {
        origin: environment.cors.origins,
        methods: environment.cors.methods,
        credentials: environment.socket.credentials
      }
    });
    return server;
  }
}

async function bootstrap() {
  log.info('====================================');
  log.info('BACKEND SERVICE STARTING');
  log.info('Process ID:', process.pid);
  log.info('Environment:', process.env.NODE_ENV || 'development');
  log.info('Current directory:', process.cwd());
  log.info('====================================');
    
  try {
    // Create an express instance explicitly
    const expressApp = express();
    
    const app = await NestFactory.create<NestExpressApplication>(
      AppModule,
      new ExpressAdapter(expressApp),
      {
        // Show errors, warnings, and log-level messages (skips verbose debug/verbose levels)
        // This includes important service messages like download status and livestream detection
        logger: ['error', 'warn', 'log'],
        abortOnError: false
      }
    );

    // Add this block to enable CORS for HTTP requests
    // Allow any localhost port for development
    const port = environment.port || process.env.PORT || 3000;

    // CORS policy is driven by environment (loopback-permissive by default,
    // restricted + non-credentialed in LAN mode). See config/environment.ts.
    app.enableCors({
      origin: environment.cors.origins,
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      credentials: environment.cors.credentials,
      allowedHeaders: 'Content-Type, Accept, Authorization, Range',
      exposedHeaders: 'Content-Range, Accept-Ranges, Content-Length'
    });

    app.useWebSocketAdapter(new ExtendedIoAdapter(app));

    // Increase body parser limit for large payloads (e.g., console logs)
    app.useBodyParser('json', { limit: '50mb' });
    app.useBodyParser('urlencoded', { limit: '50mb', extended: true });

    // Set global prefix but exclude certain routes
    app.setGlobalPrefix(environment.apiPrefix, {
      exclude: ['saved'] // Exclude /saved route from the API prefix
    });

    // Global validation pipe
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: false,
      })
    );

    // Global exception filter: sanitizes all error responses so no raw
    // filesystem paths or Node fs error codes leak to clients.
    app.useGlobalFilters(new AllExceptionsFilter());

    // Port was already declared above for CORS configuration.
    // SECURITY (A2): bind to loopback by default; only bind all interfaces when
    // LAN mode is explicitly opted in (BRIEFCASE_LAN=1). host resolves in
    // config/environment.ts.
    const host = environment.host;

    // Graceful shutdown. The Electron parent sends SIGTERM and waits before
    // force-killing; without a handler here the backend was ALWAYS force-killed,
    // so nothing ever got a chance to clean up — most visibly, Ollama models
    // stayed resident (17-25GB) after quitting until keep_alive expired.
    app.enableShutdownHooks();

    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return; // several paths can fire; run once
      shuttingDown = true;
      log.info(`Received ${signal} — releasing resources before exit...`);
      try {
        // Release Ollama models we loaded. Bounded so a hung daemon cannot keep
        // us past the parent's grace period; we get force-killed either way.
        const aiProvider = app.get(AIProviderService, { strict: false });
        await Promise.race([
          aiProvider.releaseOllamaModels(),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      } catch (error) {
        log.warn(`Error releasing Ollama models: ${(error as Error).message}`);
      }
      try {
        await app.close();
      } catch (error) {
        log.warn(`Error closing Nest application: ${(error as Error).message}`);
      }
      log.info('Graceful shutdown complete');
      process.exit(0);
    };

    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

    await app.listen(port, host);
    log.info(`=== APPLICATION STARTED ===`);
    log.info(`Server running on ${host}:${port}${environment.lanMode ? ' (LAN mode — no auth)' : ' (loopback only)'}`);
    log.info(`API endpoint: http://localhost:${port}/${environment.apiPrefix}`);
    log.info('Note: Library initialization happens automatically via onModuleInit');
  } catch (error) {
    log.error('=== BOOTSTRAP ERROR ===');
    log.error('Error during application startup:', error);
    console.error(error);  // Additional console logging
    // A9: exit non-zero so the Electron parent's health check fails fast and
    // its retry/error path triggers, rather than hanging on a dead process.
    process.exit(1);
  }
}

bootstrap();