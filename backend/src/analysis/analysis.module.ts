import { Module, forwardRef } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { SimpleTranscribeController } from './simple-transcribe.controller';
import { OllamaService } from './ollama.service';
import { AIProviderService } from './ai-provider.service';
import { AIAnalysisService } from './ai-analysis.service';
import { ChapterDetectionService } from './chapter-detection.service';
import { NliRankerService } from './nli-ranker.service';
import { LlamaManager } from '../bridges';
import { FfmpegModule } from '../ffmpeg/ffmpeg.module';
import { DownloaderModule } from '../downloader/downloader.module';
import { PathModule } from '../path/path.module';
import { SharedConfigModule } from '../config/shared-config.module';
import { LibraryModule } from '../library/library.module';
import { DatabaseModule } from '../database/database.module';
import { MediaModule } from '../media/media.module';
import { QueueModule } from '../queue/queue.module';
import { ApiKeysModule } from '../config/config.module';

@Module({
  imports: [
    FfmpegModule,
    forwardRef(() => DownloaderModule),
    PathModule,
    SharedConfigModule,
    LibraryModule,
    forwardRef(() => DatabaseModule),
    forwardRef(() => MediaModule),
    forwardRef(() => QueueModule),
    ApiKeysModule,
  ],
  controllers: [
    AnalysisController,
    SimpleTranscribeController,
  ],
  providers: [AnalysisService, OllamaService, AIProviderService, AIAnalysisService, ChapterDetectionService, NliRankerService, LlamaManager],
  exports: [AnalysisService, OllamaService, AIProviderService, AIAnalysisService, ChapterDetectionService, NliRankerService, LlamaManager],
})
export class AnalysisModule {}
