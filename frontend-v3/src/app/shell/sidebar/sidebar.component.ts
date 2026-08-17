import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { VideoTab } from '../../services/tabs.service';
import { ShellSection } from '../../core/stores/navigation.store';
import { UiBadgeComponent } from '../../ui';
import { LibrarySwitcherComponent } from './library-switcher.component';

/**
 * Shell sidebar — places only, no actions.
 *
 * Dumb presentational component: everything comes in via inputs and leaves
 * via outputs; the shell wires it to the stores/services.
 */
@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [UiBadgeComponent, LibrarySwitcherComponent],
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SidebarComponent {
  activeSection = input.required<ShellSection>();
  activeCollectionId = input<string | null>(null);
  collections = input<VideoTab[]>([]);
  queueCount = input(0);
  currentLibraryName = input('');

  selectSection = output<'library' | 'queue' | 'collections' | 'settings' | 'archives'>();
  selectCollection = output<string>();
  collectionContextMenu = output<{ collection: VideoTab; x: number; y: number }>();
  newCollection = output<void>();
  openLibrarySwitcher = output<void>();

  onCollectionContextMenu(collection: VideoTab, event: MouseEvent): void {
    event.preventDefault();
    this.collectionContextMenu.emit({ collection, x: event.clientX, y: event.clientY });
  }
}
