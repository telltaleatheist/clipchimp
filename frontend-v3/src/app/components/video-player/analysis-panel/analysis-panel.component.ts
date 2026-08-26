import { Component, Input, Output, EventEmitter, signal, computed, inject, OnChanges, SimpleChanges, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TimelineSection, TimelineChapter, CategoryFilter, AnalysisData } from '../../../models/video-editor.model';
import {
  FlagFilter,
  FLAG_FILTERS,
  FLAG_FILTER_DESCRIPTION,
  FLAG_FILTER_LABEL,
  VERIFIER_REJECTION_LABEL,
  isGhosted,
} from '../../../models/flag-filter';
import { TranscriptionSegment } from '../../../models/video-info.model';
import { TranscriptSearchService, TranscriptSearchOptions } from '../../../services/transcript-search.service';

@Component({
  selector: 'app-analysis-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './analysis-panel.component.html',
  styleUrls: ['./analysis-panel.component.scss']
})
export class AnalysisPanelComponent implements OnChanges {
  private transcriptSearchService = inject(TranscriptSearchService);
  private host = inject(ElementRef) as ElementRef<HTMLElement>;
  @Input() sections: TimelineSection[] = [];
  @Input() chapters: TimelineChapter[] = [];
  @Input() categoryFilters: CategoryFilter[] = [];
  @Input() selectedSection?: TimelineSection;
  @Input() selectedChapterId?: string;
  @Input() currentTime: number = 0;
  @Input() analysisData?: AnalysisData;
  @Input() hasAnalysis = false;
  @Input() videoId?: string;
  @Input() transcript: TranscriptionSegment[] = [];
  /**
   * The flag filter's current position, owned by the player (which does the
   * actual filtering) and rendered here. `sections` above ALREADY has this
   * filter applied — the control is here because this is where a user looks at
   * findings, not because this component decides what is visible.
   */
  @Input() flagFilter: FlagFilter = 'moderate';
  /** Per-position counts, so the control says what pressing it will do. */
  @Input() flagFilterCounts: Record<FlagFilter, number> = { strict: 0, moderate: 0, loose: 0 };
  @Output() sectionClick = new EventEmitter<TimelineSection>();
  @Output() sectionDelete = new EventEmitter<string>(); // section id
  @Output() chapterClick = new EventEmitter<TimelineChapter>();
  @Output() chapterDelete = new EventEmitter<string>(); // chapter id
  @Output() flagFilterChange = new EventEmitter<FlagFilter>();
  @Output() filterToggle = new EventEmitter<string>();
  @Output() filterSelectAll = new EventEmitter<void>();
  @Output() filterDeselectAll = new EventEmitter<void>();
  @Output() filterSelectMarkers = new EventEmitter<void>();
  @Output() generateAnalysis = new EventEmitter<string>();
  @Output() transcriptSeek = new EventEmitter<number>();

  // "Follow cursor": when enabled, the list scrolls to (and highlights) the
  // item containing the current playback position — chapter, category section,
  // or transcript segment, depending on the open view. Persisted across runs.
  followCursor = signal<boolean>(
    !(typeof localStorage !== 'undefined' && localStorage.getItem('briefcase-follow-cursor') === 'false')
  );

  // Id of the item containing currentTime, per view (recomputed on input changes)
  currentChapterId: string | null = null;
  currentSectionId: string | null = null;
  currentSegmentId: string | null = null;
  private lastFollowId: string | null = null;

  // Primary tabs
  activeTab = signal<'analysis' | 'chapters' | 'transcript'>('analysis');

  // Filter accordion state
  filtersExpanded = signal(true);

  // Transcript sub-view: segments (timestamped) or plain (continuous text)
  transcriptView = signal<'segments' | 'plain'>('segments');

  // Brief "Copied" feedback for the transcript copy button
  transcriptCopied = signal(false);

  // Transcript search
  transcriptSearch = signal('');

  // Transcript search options
  searchOptions: TranscriptSearchOptions = {
    useSoundex: false,
    usePhraseSearch: false
  };

  // Computed plain text transcript
  plainTranscript = computed(() => {
    return this.transcript.map(s => s.text).join(' ').trim();
  });

  // Filtered plain text (for search)
  get filteredPlainTranscript(): string {
    const query = this.transcriptSearch().toLowerCase().trim();
    if (!query) return this.plainTranscript();

    // For plain view, just return the full text (highlighting handled in template)
    return this.plainTranscript();
  }

  // Check if search matches plain text
  get plainTextHasMatch(): boolean {
    const query = this.transcriptSearch().toLowerCase().trim();
    if (!query) return true;
    return this.plainTranscript().toLowerCase().includes(query);
  }

  get filteredTranscript(): TranscriptionSegment[] {
    const query = this.transcriptSearch().trim();
    if (!query) return this.transcript;

    return this.transcript.filter(segment =>
      this.transcriptSearchService.matchesQuery(query, segment.text, this.searchOptions)
    );
  }

  get transcriptResultCount(): number {
    if (this.transcriptView() === 'plain') {
      const query = this.transcriptSearch().toLowerCase().trim();
      if (!query) return 0;
      // Count occurrences in plain text
      const text = this.plainTranscript().toLowerCase();
      let count = 0;
      let pos = 0;
      while ((pos = text.indexOf(query, pos)) !== -1) {
        count++;
        pos += query.length;
      }
      return count;
    }
    return this.filteredTranscript.length;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['currentTime'] || changes['chapters'] || changes['sections'] ||
        changes['transcript'] || changes['categoryFilters']) {
      this.updateCurrentIds();
      if (changes['currentTime'] && this.followCursor()) {
        this.scrollToCurrent();
      }
    }
  }

  toggleFollowCursor(): void {
    const enabled = !this.followCursor();
    this.followCursor.set(enabled);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('briefcase-follow-cursor', String(enabled));
    }
    if (enabled) {
      this.scrollToCurrent(true); // jump to the current item right away
    }
  }

  // Recompute which item (per view) contains the current playback position.
  private updateCurrentIds(): void {
    const t = this.currentTime;
    const within = (start: number, end: number) => t >= start && t < end;
    this.currentChapterId = this.chapters.find(c => within(c.startTime, c.endTime))?.id ?? null;
    this.currentSectionId = this.filteredSections.find(s => within(s.startTime, s.endTime))?.id ?? null;
    this.currentSegmentId = this.transcript.find(s => within(s.startTime, s.endTime))?.id ?? null;
  }

  // The id to follow for whichever tab is currently open.
  private get currentFollowId(): string | null {
    switch (this.activeTab()) {
      case 'transcript': return this.currentSegmentId;
      case 'chapters': return this.currentChapterId;
      default: return this.currentSectionId; // analysis (categories)
    }
  }

  // Scroll the highlighted (.follow-current) item into view. Skips work when
  // the target hasn't changed, unless `force` is set (e.g. on toggle/view switch).
  private scrollToCurrent(force = false): void {
    if (!this.followCursor()) return;
    const id = this.currentFollowId;
    if (!id || (!force && id === this.lastFollowId)) return;
    this.lastFollowId = id;
    // Wait for the view to render the .follow-current class before scrolling.
    requestAnimationFrame(() => {
      const el = this.host.nativeElement.querySelector('.follow-current') as HTMLElement | null;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  setActiveTab(tab: 'analysis' | 'chapters' | 'transcript'): void {
    this.activeTab.set(tab);
    this.scrollToCurrent(true);
  }

  toggleFilters(): void {
    this.filtersExpanded.set(!this.filtersExpanded());
  }

  setTranscriptView(view: 'segments' | 'plain'): void {
    this.transcriptView.set(view);
    this.scrollToCurrent(true);
  }

  // Check if a chapter is currently playing
  isCurrentChapter(chapter: TimelineChapter): boolean {
    return this.currentTime >= chapter.startTime && this.currentTime < chapter.endTime;
  }

  onChapterClick(chapter: TimelineChapter): void {
    this.chapterClick.emit(chapter);
  }

  onChapterDelete(chapter: TimelineChapter): void {
    this.chapterDelete.emit(chapter.id);
  }

  formatChapterDuration(chapter: TimelineChapter): string {
    const duration = chapter.endTime - chapter.startTime;
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  onTranscriptSearchChange(value: string): void {
    this.transcriptSearch.set(value);
  }

  clearTranscriptSearch(): void {
    this.transcriptSearch.set('');
  }

  onTranscriptSegmentClick(segment: TranscriptionSegment): void {
    this.transcriptSeek.emit(segment.startTime);
  }

  // Copy the full transcript to the clipboard as plain text (no timestamps/segments)
  async copyTranscript(): Promise<void> {
    const text = this.plainTranscript();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.transcriptCopied.set(true);
      setTimeout(() => this.transcriptCopied.set(false), 1500);
    } catch (err) {
      console.error('Failed to copy transcript:', err);
    }
  }

  onGenerateAnalysis(): void {
    if (this.videoId) {
      this.generateAnalysis.emit(this.videoId);
    }
  }

  // Get sections sorted chronologically and filtered by enabled categories
  get filteredSections(): TimelineSection[] {
    return this.sections
      .filter(section => this.isCategoryEnabled(section.category))
      .sort((a, b) => a.startTime - b.startTime);
  }

  // Group sections by category (kept for category filter chips)
  get sectionsByCategory(): Map<string, TimelineSection[]> {
    const grouped = new Map<string, TimelineSection[]>();

    for (const section of this.sections) {
      const category = section.category.toLowerCase();
      if (!grouped.has(category)) {
        grouped.set(category, []);
      }
      grouped.get(category)!.push(section);
    }

    // Sort sections within each category by start time
    grouped.forEach((sections, key) => {
      sections.sort((a, b) => a.startTime - b.startTime);
    });

    return grouped;
  }

  get categories(): string[] {
    return Array.from(this.sectionsByCategory.keys()).sort();
  }

  getCategoryColor(category: string): string {
    const filter = this.categoryFilters.find(f => f.category.toLowerCase() === category.toLowerCase());
    return filter?.color || '#6c757d';
  }

  // ---- flag filter -------------------------------------------------------
  readonly flagFilterPositions = FLAG_FILTERS;
  readonly flagFilterLabel = FLAG_FILTER_LABEL;
  readonly flagFilterDescription = FLAG_FILTER_DESCRIPTION;
  readonly verifierRejectionLabel = VERIFIER_REJECTION_LABEL;

  onFlagFilterSelect(filter: FlagFilter): void {
    if (filter !== this.flagFilter) this.flagFilterChange.emit(filter);
  }

  /**
   * True for a passage the verifier REJECTED — one it read as reported, quoted,
   * questioned or opposed rather than asserted. Only ever reaches this component
   * at the LOOSE position, where it renders ghosted and captioned instead of
   * being silently absent.
   */
  isGhostSection(section: TimelineSection): boolean {
    return isGhosted(section);
  }

  isCategoryEnabled(category: string): boolean {
    const filter = this.categoryFilters.find(f => f.category.toLowerCase() === category.toLowerCase());
    return filter?.enabled ?? true;
  }

  getSectionsForCategory(category: string): TimelineSection[] {
    return this.sectionsByCategory.get(category) || [];
  }

  onSectionClick(section: TimelineSection): void {
    this.sectionClick.emit(section);
  }

  onFilterToggle(category: string): void {
    this.filterToggle.emit(category);
  }

  onSelectAllFilters(): void {
    this.filterSelectAll.emit();
  }

  onDeselectAllFilters(): void {
    this.filterDeselectAll.emit();
  }

  onSelectMarkersFilters(): void {
    this.filterSelectMarkers.emit();
  }

  onSectionDelete(section: TimelineSection): void {
    this.sectionDelete.emit(section.id);
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  formatTimeRange(start: number, end: number): string {
    return `${this.formatTime(start)} - ${this.formatTime(end)}`;
  }
}
