import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { getApiBase } from '../core/runtime-url';

export type ComponentKind = 'binary' | 'whisper-model' | 'llama-model' | 'python-env';

export interface ComponentStatus {
  id: string;
  name: string;
  kind: ComponentKind;
  required: boolean;
  description?: string;
  supported: boolean;
  installed: boolean;
  sizeBytes: number;
  installedAt?: string;
}

/**
 * Frontend access to the download-on-demand component system
 * (ComponentManagerService). Mirrors AiSetupService's HTTP style; download
 * progress arrives via WebsocketService 'component.download.*' events.
 */
@Injectable({ providedIn: 'root' })
export class ComponentService {
  private readonly API_BASE = getApiBase();

  /** Last-known component list, kept reactive for the settings/wizard UI. */
  readonly components = signal<ComponentStatus[]>([]);

  constructor(private http: HttpClient) {}

  listComponents(): Observable<ComponentStatus[]> {
    return this.http.get<any>(`${this.API_BASE}/config/components`).pipe(
      map((res) => {
        const components: ComponentStatus[] = res.components || [];
        this.components.set(components);
        return components;
      }),
      catchError((error) => {
        console.error('Error listing components:', error);
        return of([] as ComponentStatus[]);
      }),
    );
  }

  /**
   * Like listComponents() but SURFACES fetch failures instead of swallowing them
   * into an empty list. The first-run check must tell "backend reports nothing is
   * missing" apart from "couldn't reach the backend" — the latter must retry or
   * show an error, never silently skip setup (which would leave a binary-less
   * install looking fine until the first download/transcode fails). Still updates
   * the reactive `components` signal on success.
   */
  fetchComponents(): Observable<ComponentStatus[]> {
    return this.http.get<any>(`${this.API_BASE}/config/components`).pipe(
      map((res) => {
        const components: ComponentStatus[] = res.components || [];
        this.components.set(components);
        return components;
      }),
    );
  }

  /** True if any required, supported component is not yet installed. */
  hasMissingRequired(components: ComponentStatus[]): boolean {
    return components.some((c) => c.required && c.supported && !c.installed);
  }

  /**
   * Components that must be present before the app is usable: downloading
   * (yt-dlp) and transcoding/probing (ffmpeg + ffprobe, both shipped inside the
   * ffmpeg-tools component). Everything else — the whisper/llama engines and all
   * models — can finish downloading in the background while the library loads.
   */
  static readonly ESSENTIAL_IDS = ['ffmpeg-tools', 'yt-dlp'];

  isEssential(id: string): boolean {
    return ComponentService.ESSENTIAL_IDS.includes(id);
  }

  /** True if an essential, supported component is not yet installed. */
  hasMissingEssential(components: ComponentStatus[]): boolean {
    return components.some((c) => this.isEssential(c.id) && c.supported && !c.installed);
  }

  /**
   * Start an install. `force` is the repair path for locally-constructed
   * components (the NLI Python environment): it rebuilds instead of no-opping on
   * an environment that already looks present. Ignored for downloads.
   */
  installComponent(id: string, force = false): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/config/install-component`, { id, force }).pipe(
      map((res) => ({ success: res.success || false, message: res.message || 'Install started' })),
      catchError((error) => {
        console.error('Error installing component:', error);
        throw error;
      }),
    );
  }

  cancelComponent(): Observable<{ success: boolean; message: string }> {
    return this.http.post<any>(`${this.API_BASE}/config/cancel-component`, {}).pipe(
      map((res) => ({ success: res.success || false, message: res.message || '' })),
      catchError((error) => {
        console.error('Error cancelling component:', error);
        throw error;
      }),
    );
  }

  removeComponent(id: string): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.API_BASE}/config/component/${id}`).pipe(
      map((res) => ({ success: res.success || false, message: res.message || 'Removed' })),
      catchError((error) => {
        console.error('Error removing component:', error);
        throw error;
      }),
    );
  }
}
