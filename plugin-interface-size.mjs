const minimumWidth = 280;
const minimumHeight = 180;

export function constrainPluginInterfaceSize(width, height, anchor, resizeInfo, available) {
	if (!resizeInfo.canResizeHorizontally) width = anchor.width;
	if (!resizeInfo.canResizeVertically) height = anchor.height;
	width = Math.max(1, width);
	height = Math.max(1, height);
	const minWidth = Math.min(minimumWidth, available.width);
	const minHeight = Math.min(minimumHeight, available.height);

	const ratio = Number(resizeInfo.aspectRatioWidth) / Number(resizeInfo.aspectRatioHeight);
	const preserveRatio = resizeInfo.preserveAspectRatio && ratio > 0
		&& resizeInfo.canResizeHorizontally && resizeInfo.canResizeVertically;
	if (preserveRatio) {
		const widthChange = Math.abs(width - anchor.width) / Math.max(anchor.width, 1);
		const heightChange = Math.abs(height - anchor.height) / Math.max(anchor.height, 1);
		if (widthChange >= heightChange) height = width / ratio;
		else width = height * ratio;
	}

	if (preserveRatio) {
		const minimumScale = Math.max(1, minWidth / width, minHeight / height);
		width *= minimumScale;
		height *= minimumScale;
		const scale = Math.min(1, available.width / width, available.height / height);
		width *= scale;
		height *= scale;
	} else {
		if (resizeInfo.canResizeHorizontally)
			width = Math.min(available.width, Math.max(minWidth, width));
		if (resizeInfo.canResizeVertically)
			height = Math.min(available.height, Math.max(minHeight, height));
	}
	return {width, height};
}
