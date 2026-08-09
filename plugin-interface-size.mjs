export function constrainPluginInterfaceSize(width, height, anchor, resizeInfo, available) {
	if (!resizeInfo.canResizeHorizontally) width = anchor.width;
	if (!resizeInfo.canResizeVertically) height = anchor.height;

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
		const scale = Math.min(1, available.width / width, available.height / height);
		width *= scale;
		height *= scale;
	} else {
		if (resizeInfo.canResizeHorizontally) width = Math.min(width, available.width);
		if (resizeInfo.canResizeVertically) height = Math.min(height, available.height);
	}
	return {width: Math.max(1, width), height: Math.max(1, height)};
}
