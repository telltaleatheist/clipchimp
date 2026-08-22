import { Component, EventEmitter, Input, Output, OnInit, OnChanges, OnDestroy, SimpleChanges, inject, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { VideoJobSettings } from '../../models/video-processing.model';
import { AiSetupService } from '../../services/ai-setup.service';
import { TourService } from '../../services/tour.service';
import { LibraryService } from '../../services/library.service';
import { PipelinePresetsService } from '../../core/stores/pipeline-presets.service';
import { getApiBase } from '../../core/runtime-url';

interface CustomInstructionHistoryItem {
  id: number;
  instruction_text: string;
  used_at: string;
  use_count: number;
}

interface AIModelOption {
  value: string;
  label: string;
  provider: 'local' | 'ollama' | 'claude' | 'openai';
}

@Component({
  selector: 'app-video-config-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './video-config-dialog.component.html',
  styleUrls: ['./video-config-dialog.component.scss']
})
export class VideoConfigDialogComponent implements OnInit, OnChanges, OnDestroy {
  private aiSetupService = inject(AiSetupService);
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private tourService = inject(TourService);
  private libraryService = inject(LibraryService);
  private presetsService = inject(PipelinePresetsService);
  private readonly API_BASE = getApiBase();
  private modelsChangedSub?: Subscription;

  @Input() isOpen = false;
  @Output() closeDialog = new EventEmitter<void>();
  @Output() submitConfig = new EventEmitter<{ url: string; name: string; settings: VideoJobSettings }[]>();
  @Output() captureWebpage = new EventEmitter<string[]>();

  captureMode: 'video' | 'webpage' = 'video';

  urlText = '';
  loadingModels = false;
  savedAsDefault = false;
  aiModels: AIModelOption[] = [];
  whisperModels: { id: string; name: string; description: string }[] = [];

  // Custom instructions history
  instructionsHistory: CustomInstructionHistoryItem[] = [];
  showInstructionsDropdown = false;

  settings: VideoJobSettings = {
    fixAspectRatio: false,
    normalizeAudio: false,
    audioLevel: -16, // Default to -16 LUFS (standard web/podcast level)
    transcribe: false,
    whisperModel: 'base',
    whisperLanguage: '',
    whisperTranslate: false,
    aiAnalysis: false,
    aiModel: '',
    customInstructions: '',
    analysisGranularity: 2, // Default to middle (balanced)
    outputFormat: 'mp4',
    outputQuality: 'high'
  };

  ngOnInit() {
    this.loadAIModels();
    this.loadInstructionsHistory();
    this.loadDefaultGranularity();

    // Subscribe to model changes from other components (e.g., AI wizard)
    this.modelsChangedSub = this.aiSetupService.modelsChanged$.subscribe(async () => {
      console.log('Models changed event received, reloading AI models...');
      await this.loadAIModels();
      this.cdr.detectChanges();
    });
  }

  ngOnDestroy() {
    this.modelsChangedSub?.unsubscribe();
  }

  private loadInstructionsHistory() {
    this.libraryService.getCustomInstructionsHistory().subscribe({
      next: (response) => {
        if (response.success) {
          this.instructionsHistory = response.history;
        }
      },
      error: (error) => {
        console.error('Failed to load instructions history:', error);
      }
    });
  }

  toggleInstructionsDropdown() {
    this.showInstructionsDropdown = !this.showInstructionsDropdown;
    if (this.showInstructionsDropdown) {
      this.loadInstructionsHistory();
    }
  }

  selectHistoryItem(item: CustomInstructionHistoryItem) {
    this.settings.customInstructions = item.instruction_text;
    this.showInstructionsDropdown = false;
  }

  truncateInstruction(text: string, maxLength: number = 60): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  getGranularityLabel(): string {
    const value = this.settings.analysisGranularity || 2;
    if (value <= 1) return 'Strong matches only';
    if (value === 2) return 'Balanced';
    return 'Aggressive';
  }

  getGranularityDescription(): string {
    const value = this.settings.analysisGranularity || 2;
    if (value <= 1) return 'Only explicit, unmistakable matches. Fewest false positives.';
    if (value === 2) return 'Clear matches plus reasonably likely ones.';
    return 'Everything that could match, including implication and coded language. Expect more to review.';
  }

  getAudioLevelLabel(): string {
    const level = this.settings.audioLevel || -16;
    return `${level} LUFS`;
  }

  getAudioLevelDescription(): string {
    const level = this.settings.audioLevel || -16;
    if (level <= -22) return 'Very quiet - suitable for background music or ambient content';
    if (level <= -19) return 'Quiet - similar to traditional broadcast standards (EBU R128)';
    if (level <= -17) return 'Moderate - good for podcasts and general web content';
    if (level <= -15) return 'Standard - typical for YouTube and streaming platforms';
    return 'Loud - maximizes perceived volume, may reduce dynamic range';
  }

  private loadDefaultGranularity() {
    this.libraryService.getDefaultGranularity().subscribe({
      next: (response) => {
        if (response.success) {
          this.settings.analysisGranularity = response.granularity;
          console.log('Loaded default granularity:', response.granularity);
        }
      },
      error: (error) => {
        console.error('Failed to load default granularity:', error);
      }
    });
  }

  onGranularityChange() {
    // Auto-save granularity when it changes
    this.libraryService.saveDefaultGranularity(this.settings.analysisGranularity || 2).subscribe({
      next: (response) => {
        if (response.success) {
          console.log('Saved default granularity:', response.granularity);
        }
      },
      error: (error) => {
        console.error('Failed to save default granularity:', error);
      }
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    // Reload models every time the modal opens to get the latest library default
    if (changes['isOpen'] && changes['isOpen'].currentValue === true) {
      console.log('Modal opened, reloading AI models and library default...');
      this.loadAIModels();

      // Start the video config tour
      setTimeout(() => {
        this.tourService.tryAutoStartTour('video-config', 500);
      }, 300);
    }
  }

  private async loadAIModels() {
    this.loadingModels = true;

    try {
      // Load whisper models dynamically
      try {
        const whisperResponse = await this.http.get<{ success: boolean; models: any[]; default: string }>(
          `${this.API_BASE}/media/whisper-models`
        ).toPromise();
        if (whisperResponse?.success && whisperResponse.models.length > 0) {
          this.whisperModels = whisperResponse.models;
          // Set default whisper model if not already set
          if (!this.settings.whisperModel || !whisperResponse.models.find(m => m.id === this.settings.whisperModel)) {
            this.settings.whisperModel = whisperResponse.default || whisperResponse.models[0].id;
          }
        }
      } catch (error) {
        console.error('Failed to fetch whisper models:', error);
        // Fallback to defaults if API fails
        this.whisperModels = [
          { id: 'tiny', name: 'Tiny', description: 'Fastest' },
          { id: 'base', name: 'Base', description: 'Best quality' }
        ];
      }

      const availability = await this.aiSetupService.checkAIAvailability();
      const models: AIModelOption[] = [];

      // Always try to fetch downloaded Local AI models (don't rely on hasLocal flag which may be stale)
      try {
        const localModelsResult = await this.aiSetupService.getLocalModels().toPromise();
        if (localModelsResult?.models) {
          const downloadedModels = localModelsResult.models.filter(m => m.downloaded);
          downloadedModels.forEach(model => {
            models.push({
              value: `local:${model.id}`,
              label: `${model.name} (Local)`,
              provider: 'local'
            });
          });
        }
      } catch (error) {
        console.error('Failed to fetch local models:', error);
      }

      // Add Ollama models (fetched dynamically by aiSetupService)
      if (availability.hasOllama && availability.ollamaModels.length > 0) {
        availability.ollamaModels.forEach(model => {
          models.push({
            value: `ollama:${model}`,
            label: model,
            provider: 'ollama'
          });
        });
      }

      // Fetch Claude models dynamically from API
      if (availability.hasClaudeKey) {
        try {
          const claudeResponse = await this.http.get<{ success: boolean; models: any[] }>(
            `${this.API_BASE}/config/claude-models`
          ).toPromise();
          if (claudeResponse?.success && claudeResponse.models.length > 0) {
            claudeResponse.models.forEach(m => {
              models.push({ value: m.value, label: m.label, provider: 'claude' });
            });
          }
        } catch (error) {
          console.error('Failed to fetch Claude models:', error);
        }
      }

      // Fetch OpenAI models dynamically from API
      if (availability.hasOpenAIKey) {
        try {
          const openaiResponse = await this.http.get<{ success: boolean; models: any[] }>(
            `${this.API_BASE}/config/openai-models`
          ).toPromise();
          if (openaiResponse?.success && openaiResponse.models.length > 0) {
            openaiResponse.models.forEach(m => {
              models.push({ value: m.value, label: m.label, provider: 'openai' });
            });
          }
        } catch (error) {
          console.error('Failed to fetch OpenAI models:', error);
        }
      }

      this.aiModels = models;
      // Force change detection to update the dropdown
      this.cdr.detectChanges();

      // Resolve which model to preselect. Precedence: the model the user last
      // chose (a personal preference, tracked across every picker) → the
      // library default → the global config default → none. Only honor a
      // last-used value that's actually installed, so a stale pick never
      // selects a missing model.
      let defaultModel: string | null = null;
      console.log('=== LOADING DEFAULT AI MODEL ===');

      const remembered = this.presetsService.lastChosenAiModel();
      if (remembered && models.some(m => m.value === remembered)) {
        defaultModel = remembered;
        console.log('Step 0 Result - Using last-used AI model:', defaultModel);
      }

      // If no last-used pick, fall back to the library's saved default
      if (!defaultModel) {
        try {
          console.log('Step 1: Fetching library default from:', `${this.API_BASE}/database/libraries/default-ai-model`);
          const response = await this.http.get<{ success: boolean; aiModel: string | null }>(
            `${this.API_BASE}/database/libraries/default-ai-model`
          ).toPromise();
          console.log('Step 1 Response:', JSON.stringify(response));
          defaultModel = response?.aiModel || null;
          console.log('Step 1 Result - Library default AI model:', defaultModel);
        } catch (error) {
          console.error('Step 1 FAILED - Error fetching library default:', error);
        }
      }

      // If no library-specific default, try global config default
      if (!defaultModel) {
        console.log('Step 2: No library default, checking global config at:', `${this.API_BASE}/config/default-ai`);
        try {
          const configResponse = await this.http.get<{ success: boolean; defaultAI: { provider: string; model: string } | null }>(
            `${this.API_BASE}/config/default-ai`
          ).toPromise();
          console.log('Step 2 Response:', JSON.stringify(configResponse));
          if (configResponse?.defaultAI) {
            defaultModel = `${configResponse.defaultAI.provider}:${configResponse.defaultAI.model}`;
            console.log('Step 2 Result - Using global config default AI model:', defaultModel);
          } else {
            console.log('Step 2 Result - No global default AI configured');
          }
        } catch (error) {
          console.error('Step 2 FAILED - Error fetching global default:', error);
        }
      }

      console.log('Step 3: Available models in dropdown:', models.map(m => m.value));
      console.log('Step 3: Final default model to apply:', defaultModel);

      // Set default model - NO FALLBACK, user must select or have a saved default
      if (models.length > 0) {
        const modelExists = defaultModel && models.some(m => m.value === defaultModel);
        console.log('Step 4: Does default model exist in list?', modelExists);

        if (modelExists) {
          this.settings.aiModel = defaultModel!;
          console.log('✓ Step 4: Successfully set settings.aiModel to:', this.settings.aiModel);
          // Force change detection
          this.cdr.detectChanges();
          console.log('✓ Step 4: Change detection triggered, current value:', this.settings.aiModel);
        } else {
          // NO FALLBACK - leave empty, user must select
          this.settings.aiModel = '';
          if (defaultModel) {
            console.warn('⚠ Step 4: Saved default model NOT FOUND in current models list:', defaultModel);
            console.warn('⚠ Step 4: User must select a model. Available values are:', models.map(m => m.value));
          } else {
            console.log('Step 4: No saved default, user must select a model');
          }
        }
      }
      console.log('=== FINAL settings.aiModel:', this.settings.aiModel, '===');
    } catch (error) {
      console.error('Failed to load AI models:', error);
    } finally {
      this.loadingModels = false;
    }
  }

  private extractModelSize(modelName: string): number {
    const match = modelName.match(/(\d+)b/i);
    if (match) {
      return parseInt(match[1], 10);
    }
    return 0;
  }

  getModelsByProvider(provider: 'local' | 'ollama' | 'claude' | 'openai'): AIModelOption[] {
    return this.aiModels.filter(m => m.provider === provider);
  }

  hasModelsForProvider(provider: 'local' | 'ollama' | 'claude' | 'openai'): boolean {
    return this.aiModels.some(m => m.provider === provider);
  }

  /**
   * Handle AI model change: record the pick as the user's remembered last model
   * (a personal preference, honored ahead of the configured default next time
   * any picker seeds an empty selection), and reset the saved-as-default state.
   * Reads the authoritative value off the event target so it's independent of
   * ngModel's write ordering.
   */
  onAiModelChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.presetsService.rememberAiModel(value);
    // Reset saved state when model changes
    this.savedAsDefault = false;
  }

  /**
   * Save the selected AI model as both library-specific and global default
   * This ensures consistency across all dialogs and modals
   */
  async saveAsDefault() {
    if (!this.settings.aiModel) {
      return;
    }

    // Saving as default also makes it the remembered last pick, so every picker
    // seeds to it consistently.
    this.presetsService.rememberAiModel(this.settings.aiModel);

    try {
      // Save to library-specific storage
      await this.http.post(
        `${this.API_BASE}/database/libraries/default-ai-model`,
        { aiModel: this.settings.aiModel }
      ).toPromise();
      console.log('Saved default AI model for library:', this.settings.aiModel);

      // Also save to global config storage for consistency
      const [provider, ...modelParts] = this.settings.aiModel.split(':');
      const model = modelParts.join(':');
      await this.http.post(
        `${this.API_BASE}/config/default-ai`,
        { provider, model }
      ).toPromise();
      console.log('Saved default AI model to global config:', this.settings.aiModel);

      // Show success feedback
      this.savedAsDefault = true;
      // Reset after 1 second
      setTimeout(() => {
        this.savedAsDefault = false;
      }, 1000);
    } catch (error) {
      console.error('Failed to save default AI model:', error);
    }
  }

  getUrlCount(): number {
    return this.getUrls().length;
  }

  private getUrls(): string[] {
    return this.urlText
      .split('\n')
      .map(url => url.trim())
      .filter(url => url.length > 0 && (url.startsWith('http://') || url.startsWith('https://')));
  }

  onSubmit(): void {
    if (this.captureMode === 'webpage') {
      this.onSubmitWebpage();
      return;
    }

    const urls = this.getUrls();
    if (urls.length === 0) return;

    // Save custom instructions to history if provided
    if (this.settings.customInstructions && this.settings.customInstructions.trim()) {
      this.libraryService.saveCustomInstruction(this.settings.customInstructions.trim()).subscribe({
        error: (error) => console.error('Failed to save instruction to history:', error)
      });
    }

    const configs = urls.map(url => ({
      url,
      name: this.extractNameFromUrl(url),
      settings: { ...this.settings }
    }));

    this.submitConfig.emit(configs);
    this.close();
  }

  onSubmitWebpage(): void {
    const urls = this.getUrls();
    if (urls.length === 0) return;
    this.captureWebpage.emit(urls);
    this.close();
  }

  close(): void {
    this.closeDialog.emit();
    this.resetForm();
  }

  private resetForm(): void {
    this.urlText = '';
    this.captureMode = 'video';
    // Reset settings but keep the saved default AI model - it will be loaded fresh when dialog reopens
    this.settings = {
      fixAspectRatio: false,
      normalizeAudio: false,
      audioLevel: -16, // Default to -16 LUFS (standard web/podcast level)
      transcribe: false,
      whisperModel: 'base',
      whisperLanguage: '',
      whisperTranslate: false,
      aiAnalysis: false,
      aiModel: '', // Will be set from saved default when dialog reopens
      customInstructions: '',
      analysisGranularity: 2, // Default to middle (balanced)
      outputFormat: 'mp4',
      outputQuality: 'high'
    };
  }

  private extractNameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      // Try to get video ID or title from common platforms
      if (urlObj.hostname.includes('youtube') || urlObj.hostname.includes('youtu.be')) {
        const videoId = urlObj.searchParams.get('v') || urlObj.pathname.split('/').pop();
        return `YouTube Video ${videoId}`;
      }
      if (urlObj.hostname.includes('vimeo')) {
        return `Vimeo Video ${urlObj.pathname.split('/').pop()}`;
      }
      const path = urlObj.pathname;
      const filename = path.split('/').pop() || 'Video';
      return filename.replace(/\.[^/.]+$/, '');
    } catch {
      return 'Video';
    }
  }
}
