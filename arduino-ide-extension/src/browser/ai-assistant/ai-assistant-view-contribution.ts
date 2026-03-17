import {
  injectable,
} from '@theia/core/shared/inversify';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { MenuModelRegistry } from '@theia/core/lib/common/menu';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { AiAssistantWidget } from './ai-assistant-widget';
import { ArduinoMenus } from '../menu/arduino-menus';
import { ArduinoToolbar } from '../toolbar/arduino-toolbar';

export namespace AiAssistant {
  export namespace Commands {
    export const TOGGLE = {
      id: AiAssistantWidget.ID + ':toggle',
      label: 'AI Assistant',
    };
    export const TOGGLE_TOOLBAR = {
      id: AiAssistantWidget.ID + ':toggle-toolbar',
    };
  }
}

@injectable()
export class AiAssistantViewContribution
  extends AbstractViewContribution<AiAssistantWidget>
  implements FrontendApplicationContribution
{
  static readonly TOGGLE_AI_ASSISTANT_TOOLBAR =
    AiAssistantWidget.ID + ':toggle-toolbar';

  constructor() {
    super({
      widgetId: AiAssistantWidget.ID,
      widgetName: AiAssistantWidget.LABEL,
      defaultWidgetOptions: {
        area: 'right',
      },
      toggleCommandId: AiAssistant.Commands.TOGGLE.id,
      toggleKeybinding: 'CtrlCmd+Shift+A',
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    if (this.toggleCommand) {
      menus.registerMenuAction(ArduinoMenus.TOOLS__MAIN_GROUP, {
        commandId: this.toggleCommand.id,
        label: AiAssistantWidget.LABEL,
        order: '7',
      });
    }
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    if (this.toggleCommand) {
      commands.registerCommand(
        { id: AiAssistantViewContribution.TOGGLE_AI_ASSISTANT_TOOLBAR },
        {
          isVisible: (widget) =>
            ArduinoToolbar.is(widget) && widget.side === 'right',
          execute: () => this.toggle(),
        }
      );
    }
  }

  protected async toggle(): Promise<void> {
    const widget = this.tryGetWidget();
    if (widget) {
      widget.dispose();
    } else {
      await this.openView({ activate: true, reveal: true });
    }
  }

  /** Called externally to push compiler errors into the visible widget */
  updateCompilerErrors(errorsText: string): void {
    const widget = this.tryGetWidget();
    if (widget) {
      widget.setLastCompilerErrors(errorsText);
    }
  }

  onStop(): void {
    // nothing to dispose
  }
}
