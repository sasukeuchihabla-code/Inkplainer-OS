(() => {
  const origin = document.getElementById('origin');
  const scriptStatus = document.getElementById('script-status');
  const board = document.getElementById('touch-board');
  const result = document.getElementById('touch-result');
  const clearButton = document.getElementById('clear-board');

  origin.textContent = window.location.origin;
  scriptStatus.textContent = 'Local JavaScript loaded';

  const context = board.getContext('2d');
  let pointerCount = 0;
  let isDrawing = false;

  function pointFromEvent(event) {
    const bounds = board.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) * (board.width / bounds.width),
      y: (event.clientY - bounds.top) * (board.height / bounds.height),
    };
  }

  function drawPoint(point) {
    context.fillStyle = '#5266df';
    context.beginPath();
    context.arc(point.x, point.y, 7, 0, Math.PI * 2);
    context.fill();
  }

  board.addEventListener('pointerdown', (event) => {
    isDrawing = true;
    pointerCount += 1;
    board.setPointerCapture(event.pointerId);
    drawPoint(pointFromEvent(event));
    result.textContent = `Pointer input received (${event.pointerType}); ${pointerCount} touch event${pointerCount === 1 ? '' : 's'}.`;
    event.preventDefault();
  });

  board.addEventListener('pointermove', (event) => {
    if (isDrawing) drawPoint(pointFromEvent(event));
  });

  function stopDrawing() {
    isDrawing = false;
  }

  board.addEventListener('pointerup', stopDrawing);
  board.addEventListener('pointercancel', stopDrawing);
  clearButton.addEventListener('click', () => {
    context.clearRect(0, 0, board.width, board.height);
    pointerCount = 0;
    result.textContent = 'Board cleared. Tap or drag to test again.';
  });
})();
