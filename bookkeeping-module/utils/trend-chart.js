const DEFAULT_SIZE = { width: 600, height: 240 };

function buildTrendChart(points, size = DEFAULT_SIZE) {
  const empty = { trendPoints: [], trendDisplayPoints: [], trendAxisLabels: [], trendSegments: [], trendZeroTop: 50 };
  if (!points.length) return empty;
  const width = size.width > 0 ? size.width : DEFAULT_SIZE.width;
  const height = size.height > 0 ? size.height : DEFAULT_SIZE.height;
  const values = points.map(point => Number(point.value) || 0);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const padding = (max - min || 1) * 0.08;
  const bottom = min - padding;
  const top = max + padding;
  const span = top - bottom;
  const trendPoints = points.map((point, index) => ({
    ...point, index,
    left: points.length === 1 ? 50 : index / (points.length - 1) * 100,
    top: (top - (Number(point.value) || 0)) / span * 100,
  }));
  const createSegment = (start, end, profitClass, key) => {
    const dx = (end.left - start.left) * width / 100;
    const dy = (end.top - start.top) * height / 100;
    return { key, profitClass, left: start.left, top: start.top, width: Math.hypot(dx, dy) / width * 100, angle: Math.atan2(dy, dx) * 180 / Math.PI };
  };
  const trendSegments = [];
  // Connect every game so peaks and losses survive even in the 200-game view.
  trendPoints.slice(1).forEach((point, index) => {
    const previous = trendPoints[index];
    const previousValue = Number(previous.value) || 0;
    const currentValue = Number(point.value) || 0;
    if (previousValue * currentValue < 0) {
      const ratio = previousValue / (previousValue - currentValue);
      const crossing = {
        left: previous.left + (point.left - previous.left) * ratio,
        top: previous.top + (point.top - previous.top) * ratio,
      };
      trendSegments.push(createSegment(previous, crossing, previousValue > 0 ? 'positive' : 'negative', `${previous.id}:${point.id}:a`));
      trendSegments.push(createSegment(crossing, point, currentValue > 0 ? 'positive' : 'negative', `${previous.id}:${point.id}:b`));
    } else {
      const profitClass = previousValue > 0 || currentValue > 0 ? 'positive' : previousValue < 0 || currentValue < 0 ? 'negative' : 'neutral';
      trendSegments.push(createSegment(previous, point, profitClass, `${previous.id}:${point.id}`));
    }
  });
  const axisCount = Math.min(5, points.length);
  const axisIndexes = [...new Set(Array.from({ length: axisCount }, (_, index) =>
    axisCount === 1 ? 0 : Math.round(index * (points.length - 1) / (axisCount - 1))))];
  const trendAxisLabels = axisIndexes.map(index => {
    const point = trendPoints[index];
    return { id: point.id, label: point.label, left: point.left, alignment: points.length === 1 ? 'center' : index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'center' };
  });
  return { trendPoints, trendDisplayPoints: points.length <= 20 ? trendPoints : [], trendAxisLabels, trendSegments, trendZeroTop: top / span * 100 };
}

function nearestTrendPoint(points, x, rect) {
  if (!points.length || !Number.isFinite(x) || !rect || !(rect.width > 0)) return null;
  const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  return points[Math.round(ratio * (points.length - 1))];
}

module.exports = { buildTrendChart, nearestTrendPoint };
