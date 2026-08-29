export interface Viewport { x: number; y: number; scale: number }

export const DEFAULT_VIEW: Viewport = { x: 0, y: 0, scale: 1 };
const PAN_SAFE_MARGIN = 96;

export function zoomViewAt(current: Viewport, delta: number, anchorX: number, anchorY: number): Viewport {
  const scale = Math.min(2.6, Math.max(0.55, Number((current.scale + delta).toFixed(2))));
  if (scale === current.scale) return current;
  const ratio = scale / current.scale;
  return constrainViewport({
    scale,
    x: anchorX - (anchorX - current.x) * ratio,
    y: anchorY - (anchorY - current.y) * ratio
  });
}

/**
 * 按放大后的模组真实边界限制平移：尺寸大于画布时允许查看四条边，
 * 到达边缘后停止；尺寸小于画布时自动居中，避免滑进空白区域。
 */
export function constrainViewport(viewport: Viewport): Viewport {
  const scale = Number.isFinite(viewport.scale) ? viewport.scale : DEFAULT_VIEW.scale;
  const x = Number.isFinite(viewport.x) ? viewport.x : DEFAULT_VIEW.x;
  const y = Number.isFinite(viewport.y) ? viewport.y : DEFAULT_VIEW.y;
  return {
    scale,
    // 四个方向使用相同安全区，避免任何边缘的引脚或缩放字体贴近 SVG 裁剪线。
    x: constrainAxis(x, scale, 1120, 0, 1120, PAN_SAFE_MARGIN),
    y: constrainAxis(y, scale, 900, 0, 900, PAN_SAFE_MARGIN)
  };
}

function constrainAxis(offset: number, scale: number, viewportSize: number, contentStart: number, contentEnd: number, margin: number): number {
  const contentSize = (contentEnd - contentStart) * scale;
  if (contentSize <= viewportSize - margin * 2) {
    return (viewportSize - (contentStart + contentEnd) * scale) / 2;
  }
  const minimum = viewportSize - margin - contentEnd * scale;
  const maximum = margin - contentStart * scale;
  return Math.min(maximum, Math.max(minimum, offset));
}
