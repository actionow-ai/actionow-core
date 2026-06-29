import { ChatTool } from './ChatTool';
import { ToolRail } from './ToolRail';

/**
 * The full-height playground chrome (`/app/playground`): a left modality tool-rail
 * + the active tool. v1 renders the Chat tool; image/video/audio plug into the
 * rail as later sub-projects. Fills the routed `<Outlet/>` (the `/app` shell's
 * content area is `height:100%`), so the playground gets its own focused canvas.
 */
export function PlaygroundShell() {
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: 'var(--bg)' }}>
      <ToolRail />
      <ChatTool />
    </div>
  );
}
