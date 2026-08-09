import assert from 'node:assert/strict';
import test from 'node:test';

import {constrainPluginInterfaceSize} from '../../plugin-interface-size.mjs';

const available = {width: 1000, height: 700};

test('keeps a preferred size which already fits', () => {
	const size = constrainPluginInterfaceSize(520, 320, {width: 520, height: 320}, {
		canResizeHorizontally: true,
		canResizeVertically: true,
	}, available);
	assert.deepEqual(size, {width: 520, height: 320});
});

test('caps freely resizable interfaces to the viewport', () => {
	const size = constrainPluginInterfaceSize(1200, 800, {width: 800, height: 600}, {
		canResizeHorizontally: true,
		canResizeVertically: true,
	}, available);
	assert.deepEqual(size, available);
});

test('keeps freely resizable interfaces large enough to use', () => {
	const size = constrainPluginInterfaceSize(20, 10, {width: 640, height: 420}, {
		canResizeHorizontally: true,
		canResizeVertically: true,
	}, available);
	assert.deepEqual(size, {width: 240, height: 160});
});

test('lets a small viewport override the host minimum', () => {
	const size = constrainPluginInterfaceSize(20, 10, {width: 640, height: 420}, {
		canResizeHorizontally: true,
		canResizeVertically: true,
	}, {width: 180, height: 100});
	assert.deepEqual(size, {width: 180, height: 100});
});

test('honours horizontal-only and vertical-only hints', () => {
	assert.deepEqual(
		constrainPluginInterfaceSize(700, 600, {width: 520, height: 320}, {
			canResizeHorizontally: true,
			canResizeVertically: false,
		}, available),
		{width: 700, height: 320});
	assert.deepEqual(
		constrainPluginInterfaceSize(700, 600, {width: 520, height: 320}, {
			canResizeHorizontally: false,
			canResizeVertically: true,
		}, available),
		{width: 520, height: 600});
});

test('preserves the advertised aspect ratio while dragging and fitting', () => {
	const hints = {
		canResizeHorizontally: true,
		canResizeVertically: true,
		preserveAspectRatio: true,
		aspectRatioWidth: 4,
		aspectRatioHeight: 3,
	};
	const dragged = constrainPluginInterfaceSize(810, 600, {width: 800, height: 600}, hints, available);
	assert.ok(Math.abs(dragged.width / dragged.height - 4 / 3) < Number.EPSILON * 2);
	const fitted = constrainPluginInterfaceSize(800, 600, {width: 800, height: 600}, hints,
		{width: 700, height: 500});
	assert.ok(Math.abs(fitted.width / fitted.height - 4 / 3) < Number.EPSILON * 2);
	assert.equal(fitted.height, 500);
	const minimum = constrainPluginInterfaceSize(-100, -100, {width: 800, height: 600}, hints, available);
	assert.deepEqual(minimum, {width: 240, height: 180});
});

test('does not distort an interface with no resizable axis', () => {
	const anchor = {width: 640, height: 420};
	assert.deepEqual(constrainPluginInterfaceSize(300, 200, anchor, {
		canResizeHorizontally: false,
		canResizeVertically: false,
	}, {width: 400, height: 300}), anchor);
});
