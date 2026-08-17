import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../services/notification.service';
import { TourService } from '../../services/tour.service';

import { CascadeComponent } from '../cascade/cascade.component';
import { VideoWeek, VideoItem } from '../../models/video.model';
import { getApiBase } from '../../core/runtime-url';

export interface ExportSection {
  id: string;
  category: string;
  description: string;
  startSeconds: number;
  endSeconds: number;
  timeRange: string;
  icon?: string;
}

export interface MuteSectionExport {
  id: string;
  startSeconds: number;
  endSeconds: number;
}

export interface ExportDialogData {
  sections: ExportSection[];
  muteSections?: MuteSectionExport[];
  selectionStart?: number;
  selectionEnd?: number;
  videoId: string;
  videoPath?: string | null;  // Optional - backend can look it up by videoId if missing
  videoTitle: string;
  videoScale?: number;  // Video scale factor (1.0 = no scaling)
  cropAspectRatio?: string;  // Target crop aspect ratio (e.g. '16:9', '4:3', '9:16')
}

// Category colors for consistent styling
const CATEGORY_COLORS: Record<string, string> = {
  'export changes': '#22c55e',      // Green
  'current selection': '#ff6b35',   // Orange
  'shocking': '#f59e0b',            // Amber
  'political-violence': '#b91c1c',  // Dark Red
  'hate': '#dc2626',                // Red
  'violence': '#ef4444',            // Red
  'extremism': '#f97316',           // Orange
  'misinformation': '#eab308',      // Yellow
  'conspiracy': '#a855f7',          // Purple
  'christian-nationalism': '#ec4899', // Pink
  'false-prophecy': '#8b5cf6',      // Violet
  'marker': '#6b7280',              // Gray
  'default': '#6c757d'
};

@Component({
  selector: 'app-export-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, CascadeComponent],
  templateUrl: './export-dialog.component.html',
  styleUrls: ['./export-dialog.component.scss']
})
export class ExportDialogComponent implements OnInit, OnDestroy {
  @Input() data!: ExportDialogData;
  @Output() close = new EventEmitter<{ exported: boolean; navigateToQueue?: boolean }>();

  // Selection state
  hasSelection = false;
  selectionStart = 0;
  selectionEnd = 0;
  selectionDuration = '';
  isExporting = false;

  // Export options
  outputDirectory: string | null = null;
  reEncode = true;
  exportQuality: 'high' | 'medium' | 'low' = 'medium';
  overwriteOriginal = false;
  applyMutes = true;  // Whether to apply mute sections during export
  saveCopy = true;    // Save as copy with (censored) suffix

  // Mute sections data
  muteSections: MuteSectionExport[] = [];

  /** Re-encode is required when scale or mutes are applied (stream copy can't apply filters) */
  get reEncodeRequired(): boolean {
    const hasScale = this.data?.videoScale != null && this.data.videoScale !== 1.0;
    const hasMutesToApply = this.applyMutes && this.hasMuteSections();
    return hasScale || hasMutesToApply;
  }

  // Queue confirmation state
  exportQueued = false;
  queuedJobCount = 0;
  queuedJobIds: string[] = [];

  // Pending jobs (built on "Export" click, submitted on "Start"/"Take Me There`)
  private pendingJobs: any[] = [];

  // Sections list configuration
  sections: ExportSection[] = [];
  selectedSectionIds = new Set<string>();

  // Cascade weeks data (sections grouped by category)
  cascadeWeeks = signal<VideoWeek[]>([]);
  allCascadeWeeks = signal<VideoWeek[]>([]);  // Store unfiltered weeks

  // Filter chips for categories
  availableCategories = signal<string[]>([]);
  selectedCategories = signal<Set<string>>(new Set());

  // Map section IDs to ExportSection for lookup
  private sectionMap = new Map<string, ExportSection>();

  private readonly API_BASE = getApiBase();

  private tourService = inject(TourService);
  private http = inject(HttpClient);
  private notificationService = inject(NotificationService);

  // Pending tour-start timer, cleared on destroy.
  private tourTimeout?: ReturnType<typeof setTimeout>;


  ngOnInit() {
    // Prepare sections for cascade list
    const cascadeSections: ExportSection[] = [];

    // Always add `Export Changes" option at the top (for scale/other changes to full video)
    // Use 0 as start and a very large number as end to represent full video
    cascadeSections.push({
      id: '__full_video__',
      category: 'Export Changes',
      description: 'Export with changes',
      startSeconds: 0,
      endSeconds: Number.MAX_SAFE_INTEGER, // Will be replaced with actual duration in backend
      timeRange: 'Full Video',
      icon: 'video'
    });

    // Check if there's a valid selection and add it as the first item
    if (this.data.selectionStart !== undefined && this.data.selectionEnd !== undefined) {
      const duration = this.data.selectionEnd - this.data.selectionStart;
      if (duration >= 1) {
        this.hasSelection = true;
        this.selectionStart = this.data.selectionStart;
        this.selectionEnd = this.data.selectionEnd;
        this.selectionDuration = this.formatTime(duration);

        // Check if selection matches an existing marker/section (within 1s tolerance)
        const matchingSection = this.data.sections.find(s =>
          Math.abs(s.startSeconds - this.selectionStart) < 1 &&
          Math.abs(s.endSeconds - this.selectionEnd) < 1
        );
        const selectionDescription = matchingSection?.description || 'Current timeline selection';

        // Add selection as a cascade list item at the top
        cascadeSections.push({
          id: '__selection__',
          category: 'Current Selection',
          description: selectionDescription,
          startSeconds: this.selectionStart,
          endSeconds: this.selectionEnd,
          timeRange: `${this.formatTime(this.selectionStart)} - ${this.formatTime(this.selectionEnd)} (${this.selectionDuration})`,
          icon: 'highlight'
        });
      }
    }

    // Add marker sections
    cascadeSections.push(...this.data.sections.map(section => ({
      ...section,
      icon: 'bookmark'
    })));

    this.sections = cascadeSections;

    // Build section map for lookup
    cascadeSections.forEach(section => {
      this.sectionMap.set(section.id, section);
    });

    // Build cascadeWeeks by grouping sections by category
    this.buildCascadeWeeks(cascadeSections);

    // Initialize mute sections from dialog data
    this.muteSections = this.data.muteSections || [];

    // Start the export dialog tour
    this.tourTimeout = setTimeout(() => {
      this.tourService.tryAutoStartTour('export-dialog', 500);
    }, 300);
  }

  ngOnDestroy() {
    // Clear the pending tour timer so it can't fire against a torn-down DOM.
    if (this.tourTimeout) {
      clearTimeout(this.tourTimeout);
    }
  }

  /**
   * Check if there are mute sections to apply
   */
  hasMuteSections(): boolean {
    return this.muteSections.length > 0;
  }

  /**
   * Get mute sections formatted for display
   */
  getMuteSectionsDisplay(): Array<{ startTime: string; endTime: string; duration: string }> {
    return this.muteSections.map(section => ({
      startTime: this.formatTime(section.startSeconds),
      endTime: this.formatTime(section.endSeconds),
      duration: this.formatTime(section.endSeconds - section.startSeconds)
    }));
  }

  /**
   * Get total muted duration
   */
  getTotalMuteDuration(): string {
    const totalSeconds = this.muteSections.reduce(
      (total, section) => total + (section.endSeconds - section.startSeconds),
      0
    );
    return this.formatTime(totalSeconds);
  }

  /**
   * Build VideoWeek[] grouped by category for the cascade component
   */
  private buildCascadeWeeks(sections: ExportSection[]) {
    // Group sections by category
    const categoryMap = new Map<string, ExportSection[]>();

    // Define the order of categories (special ones first)
    const categoryOrder = ['Export Changes', 'Current Selection'];

    sections.forEach(section => {
      const category = section.category;
      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category)!.push(section);
    });

    // Sort categories: special ones first, then alphabetically
    const sortedCategories = Array.from(categoryMap.keys()).sort((a, b) => {
      const aIndex = categoryOrder.indexOf(a);
      const bIndex = categoryOrder.indexOf(b);

      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return a.localeCompare(b);
    });

    // Store available categories for filter chips
    this.availableCategories.set(sortedCategories);

    // Build weeks array
    const weeks: VideoWeek[] = sortedCategories.map(category => {
      const categorySections = categoryMap.get(category)!;
      const categoryColor = this.getCategoryColor(category);

      // Convert ExportSections to VideoItems
      const videos: VideoItem[] = categorySections.map(section => {
        // Calculate actual clip duration
        const clipDurationSeconds = section.endSeconds - section.startSeconds;
        const clipDuration = section.id === '__full_video__'
          ? 'Full'
          : this.formatTime(clipDurationSeconds);

        // Build time range for display under title
        const timeRange = section.id === '__full_video__'
          ? 'Entire video with changes applied'
          : `${this.formatTime(section.startSeconds)} - ${this.formatTime(section.endSeconds)}`;

        return {
          id: section.id,
          name: section.description,
          duration: clipDuration,  // Clip length on the right
          tags: [`category:${section.category}`, `color:${categoryColor}`],
          suggestedTitle: timeRange  // Timestamps under the title
        };
      });

      // Get icon for category
      const icon = this.getCategoryIcon(category);

      return {
        weekLabel: `${icon} ${category}`,
        videos,
        // Every category starts expanded. This dialog is a picker, so a collapsed
        // category hides the very markers the user opened it to choose — and with
        // the "no sections" message gated on sections.length (never 0, since
        // __full_video__ is always pushed), a collapsed list reads as "I have no
        // markers" rather than "your markers are one click away". The collapsed
        // default was inert until the cascade began honouring this hint (e7d4fa8);
        // before that it forced every week open.
        expanded: true
      };
    });

    // Store all weeks and set as current
    this.allCascadeWeeks.set(weeks);
    this.cascadeWeeks.set(weeks);
  }

  /**
   * Toggle category filter chip
   */
  toggleCategoryFilter(category: string) {
    const selected = new Set(this.selectedCategories());

    if (selected.has(category)) {
      selected.delete(category);
    } else {
      selected.add(category);
    }

    this.selectedCategories.set(selected);
    this.applyFilters();
  }

  /**
   * Check if a category is selected
   */
  isCategorySelected(category: string): boolean {
    const selected = this.selectedCategories();
    return selected.size === 0 || selected.has(category);
  }

  /**
   * Apply category filters to cascade weeks
   */
  private applyFilters() {
    const selected = this.selectedCategories();
    const allWeeks = this.allCascadeWeeks();

    if (selected.size === 0) {
      // No filters - show all
      this.cascadeWeeks.set(allWeeks);
    } else {
      // Filter to only show selected categories
      const filtered = allWeeks.filter(week => {
        // Extract category from weekLabel (format: "icon Category")
        const parts = week.weekLabel.split(' ');
        const category = parts.slice(1).join(' ');
        return selected.has(category);
      });
      this.cascadeWeeks.set(filtered);
    }
  }

  /**
   * Clear all category filters
   */
  clearCategoryFilters() {
    this.selectedCategories.set(new Set());
    this.cascadeWeeks.set(this.allCascadeWeeks());
  }

  /**
   * Get icon for category
   */
  getCategoryIcon(category: string): string {
    const icons: Record<string, string> = {
      'export changes': '📹',
      'current selection': '✂️',
      'hate': '🚫',
      'violence': '⚠️',
      'extremism': '🔥',
      'misinformation': '❌',
      'conspiracy': '🔮',
      'marker': '📍',
      'shocking': '⚡'
    };
    return icons[category.toLowerCase()] || '📍';
  }

  /**
   * Handle selection changes from cascade component
   * Note: Cascade uses composite itemIds like "weekLabel|videoId", we need to extract just the videoId
   */
  onCascadeSelectionChanged(event: { count: number; ids: Set<string> }) {
    // Extract the actual section IDs from the composite itemIds
    const extractedIds = new Set<string>();
    event.ids.forEach(itemId => {
      // itemId format is "weekLabel|sectionId" - extract the sectionId part
      const parts = itemId.split('|');
      const sectionId = parts.length > 1 ? parts[parts.length - 1] : itemId;
      extractedIds.add(sectionId);
    });
    this.selectedSectionIds = extractedIds;
  }

  /**
   * Handle video actions from cascade (like double-click)
   */
  onCascadeVideoAction(event: { action: string; videos: VideoItem[] }) {
    // Toggle selection on action
    if (event.action === 'open' || event.action === 'edit') {
      event.videos.forEach(video => {
        if (this.selectedSectionIds.has(video.id)) {
          this.selectedSectionIds.delete(video.id);
        } else {
          this.selectedSectionIds.add(video.id);
        }
      });
    }
  }

  onOverlayClick(event: MouseEvent) {
    // Only close if clicking directly on the overlay, not the content
    if (event.target === event.currentTarget) {
      this.cancel();
    }
  }

  getCategoryColor(category: string): string {
    return CATEGORY_COLORS[category.toLowerCase()] || CATEGORY_COLORS['default'];
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  getSelectedCount(): number {
    return this.selectedSectionIds.size;
  }

  getSelectedSections(): ExportSection[] {
    return this.sections.filter(section => this.selectedSectionIds.has(section.id));
  }

  canOverwriteOriginal(): boolean {
    const selectedSections = this.getSelectedSections();
    // Can overwrite if only one section is selected and it's either:
    // 1. The full video export (for scale-only changes)
    // 2. The current selection
    return selectedSections.length === 1 && (
      selectedSections[0].id === '__full_video__' ||
      selectedSections[0].id === '__selection__'
    );
  }

  selectAll() {
    this.sections.forEach(section => this.selectedSectionIds.add(section.id));
  }

  deselectAll() {
    this.selectedSectionIds.clear();
  }

  areAllSelected(): boolean {
    return this.sections.length > 0 && this.selectedSectionIds.size === this.sections.length;
  }

  getSelectedDuration(): string {
    const totalSeconds = this.getSelectedSections().reduce(
      (total, section) => {
        // The full-video sentinel has no real end (endSeconds = MAX_SAFE_INTEGER);
        // adding its span would render a badge of trillions of hours. Skip it.
        if (section.id === '__full_video__') return total;
        return total + (section.endSeconds - section.startSeconds);
      },
      0
    );
    return this.formatTime(totalSeconds);
  }

  cancel() {
    if (!this.isExporting) {
      this.close.emit({ exported: false });
    }
  }

  async chooseOutputDirectory() {
    const electron = (window as any).electron;
    if (electron && electron.showOpenDialog) {
      try {
        const result = await electron.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
          title: 'Choose Output Folder for Clips'
        });

        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
          this.outputDirectory = result.filePaths[0];
        }
      } catch (error) {
        console.error('Failed to open directory picker:', error);
        this.notificationService.error('Error', 'Failed to open directory picker');
      }
    } else {
      this.notificationService.info(
        'Default Location',
        'Clips will be exported to your library folder. Directory picker is only available in the desktop app.'
      );
    }
  }

  async export() {
    const selectedSections = this.getSelectedSections();

    if (selectedSections.length === 0 || this.isExporting) {
      return;
    }

    if (this.overwriteOriginal && this.canOverwriteOriginal()) {
      const confirmed = await this.confirmOverwrite();
      if (!confirmed) {
        return;
      }
      this.buildOverwriteJobs(selectedSections[0]);
    } else {
      this.buildExportJobs(selectedSections);
    }

    // Show confirmation screen (jobs are NOT submitted yet)
    this.queuedJobCount = this.pendingJobs.length;
    this.exportQueued = true;
  }

  /**
   * Build export job payloads (does NOT submit to backend)
   */
  private buildExportJobs(sections: ExportSection[]) {
    const muteSectionsForRequest = this.applyMutes && this.hasMuteSections()
      ? this.muteSections.map(s => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds }))
      : undefined;

    const outputSuffix = this.saveCopy && this.applyMutes && this.hasMuteSections()
      ? ' (censored)'
      : undefined;

    const hasScale = this.data.videoScale && this.data.videoScale !== 1.0;
    const hasMutesToApply = !!muteSectionsForRequest;
    const needsReEncode = this.reEncode || hasScale || hasMutesToApply;

    this.pendingJobs = sections.map(section => {
      const isFullVideo = section.id === '__full_video__';
      const sectionLabel = section.description || 'Unnamed';
      // Use marker/section text as the primary name when available
      const isGenericLabel = !section.description || section.description === 'Current timeline selection';
      const displayName = isFullVideo
        ? `Export: ${this.data.videoTitle}`
        : isGenericLabel
          ? `Export: ${this.data.videoTitle} — ${sectionLabel}`
          : sectionLabel;
      return {
        videoPath: this.data.videoPath,
        videoId: this.data.videoId,
        displayName,
        tasks: [{
          type: 'export-clip',
          options: {
            videoPath: this.data.videoPath,
            startTime: isFullVideo ? null : section.startSeconds,
            endTime: isFullVideo ? null : section.endSeconds,
            title: section.description,
            description: section.description,
            category: section.category,
            customDirectory: this.outputDirectory || undefined,
            reEncode: needsReEncode,
            quality: needsReEncode ? this.exportQuality : undefined,
            scale: hasScale ? this.data.videoScale : undefined,
            cropAspectRatio: this.data.cropAspectRatio,
            muteSections: muteSectionsForRequest,
            outputSuffix: outputSuffix,
          }
        }]
      };
    });
  }

  /**
   * Build overwrite job payload (does NOT submit to backend)
   */
  private buildOverwriteJobs(section: ExportSection) {
    const isFullVideo = section.id === '__full_video__';

    const muteSectionsForRequest = this.applyMutes && this.hasMuteSections()
      ? this.muteSections.map(s => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds }))
      : undefined;

    const hasScale = this.data.videoScale && this.data.videoScale !== 1.0;
    const hasMutesToApply = !!muteSectionsForRequest;
    const needsReEncode = this.reEncode || hasScale || hasMutesToApply;

    this.pendingJobs = [{
      videoPath: this.data.videoPath,
      videoId: this.data.videoId,
      displayName: `Export: ${this.data.videoTitle} — overwriting original`,
      tasks: [{
        type: 'export-clip',
        options: {
          videoPath: this.data.videoPath,
          startTime: isFullVideo ? null : section.startSeconds,
          endTime: isFullVideo ? null : section.endSeconds,
          reEncode: needsReEncode,
          quality: needsReEncode ? this.exportQuality : undefined,
          scale: hasScale ? this.data.videoScale : undefined,
          cropAspectRatio: this.data.cropAspectRatio,
          muteSections: muteSectionsForRequest,
          isOverwrite: true,
          videoId: this.data.videoId,
        }
      }]
    }];
  }

  /**
   * Submit pending jobs to the backend queue.
   *
   * Does NOT call refreshFromBackend — the main window's QueueService picks
   * up new jobs when the user navigates to the queue tab (via setActiveTab →
   * refreshFromBackend). Calling it here caused zombie pending jobs when the
   * export dialog runs in a popout editor: the popout's QueueService created
   * a frontend job and persisted it to the same localStorage the main window
   * uses, stomping on the main window's copy.
   */
  private async submitJobs(paused: boolean): Promise<boolean> {
    if (this.pendingJobs.length === 0) return false;

    try {
      const result = await firstValueFrom(
        this.http.post<any>(`${this.API_BASE}/queue/jobs/bulk`, { jobs: this.pendingJobs, paused })
      );
      this.queuedJobIds = result.jobIds || [];
      return true;
    } catch (error) {
      console.error('Failed to submit export jobs:', error);
      this.notificationService.error('Export Failed', 'Failed to submit export jobs to queue');
      return false;
    }
  }

  private async confirmOverwrite(): Promise<boolean> {
    return new Promise((resolve) => {
      const confirmed = confirm(
        'WARNING: This will permanently overwrite the original video file and delete ALL metadata including:\n\n' +
        '• Transcript\n' +
        '• Analysis sections\n' +
        '• Custom markers\n' +
        '• All other metadata\n\n' +
        'The video file will be replaced with only the highlighted section.\n\n' +
        'This action CANNOT be undone. Are you sure you want to continue?'
      );
      resolve(confirmed);
    });
  }

  /**
   * Submit jobs and start them immediately, then close the dialog
   */
  async startQueue() {
    this.isExporting = true;
    const submitted = await this.submitJobs(false);
    if (!submitted) {
      this.isExporting = false;
      return;
    }
    this.notificationService.success(
      'Export Started',
      `${this.queuedJobCount} clip${this.queuedJobCount !== 1 ? 's' : ''} queued and processing.`
    );
    this.close.emit({ exported: true });
  }

  /**
   * Cancel — just close without submitting anything
   */
  cancelQueue() {
    this.pendingJobs = [];
    this.close.emit({ exported: false });
  }

  /**
   * Submit jobs as paused and navigate to queue tab
   */
  async goToQueue() {
    this.isExporting = true;
    const submitted = await this.submitJobs(true);
    if (!submitted) {
      this.isExporting = false;
      return;
    }
    this.close.emit({ exported: true, navigateToQueue: true });
  }

  closeDialog() {
    this.close.emit({ exported: this.exportQueued });
  }
}
