/**
 * Routes for download-on-demand components. Mounted under the same /config
 * prefix as ConfigController (Nest allows multiple controllers per prefix).
 * Mirrors the model-download route style: install is fire-and-forget; progress
 * arrives over WebSocket ('component.download.*').
 */

import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ComponentManagerService } from './component-manager.service';

@Controller('config')
export class ComponentManagerController {
  constructor(private readonly components: ComponentManagerService) {}

  @Get('components')
  async listComponents() {
    const components = await this.components.listComponents();
    return { success: true, components };
  }

  @Post('install-component')
  async installComponent(@Body() body: { id: string; force?: boolean }) {
    // Fire-and-forget; the frontend tracks progress via WebSocket events.
    // `force` is the repair path — only locally-constructed components
    // (python-env) can be rebuilt in place, everything else ignores it.
    this.components.install(body.id, body.force === true).catch((err) => {
      // Errors are also surfaced via the 'component.download.error' event.
      console.error(`Component install failed: ${err.message}`);
    });
    return {
      success: true,
      message: `${body.force ? 'Repair' : 'Install'} started for ${body.id}`,
    };
  }

  @Post('cancel-component')
  async cancelComponent() {
    const cancelled = this.components.cancel();
    return {
      success: cancelled,
      message: cancelled ? 'Component download cancelled' : 'No active download to cancel',
    };
  }

  @Delete('component/:id')
  async removeComponent(@Param('id') id: string) {
    await this.components.remove(id);
    return { success: true, message: `Component ${id} removed` };
  }
}
