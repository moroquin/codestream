import React from "react";
import { PropsWithChildren } from "react";
import Tooltip from "@codestream/webview/Stream/Tooltip";
import { useDidMount } from "@codestream/webview/utilities/hooks";
import KeystrokeDispatcher from "@codestream/webview/utilities/keystroke-dispatcher";
import styled from "styled-components";
import { CSText } from "./CSText";
import Icon from "@codestream/webview/Stream/Icon";
import { Modal } from "@codestream/webview/Stream/Modal";

export const ButtonRow = styled.div`
	text-align: right;
	margin-top: 10px;
	flex-wrap: wrap;
	justify-content: flex-end;
	white-space: normal; // required for wrap
	button {
		margin: 10px 0 0 10px;
	}
`;

const Box = styled.div<{
	narrow?: boolean;
	wide?: boolean;
	noPadding?: boolean;
	limitHeight?: boolean;
}>`
	background: var(--base-background-color);
	border: 1px solid var(--base-border-color);
	box-shadow: 0 5px 10px rgba(0, 0, 0, 0.2);
	.vscode-dark & {
		box-shadow: 0 5px 10px rgba(0, 0, 0, 0.5);
	}
	padding: ${props => (props.noPadding ? "0" : "20px 20px 20px 20px")};
	position: relative;
	margin: 0 auto;
	display: inline-block;
	text-align: left;
	.standard-form {
		padding: 0;
		.form-body {
			padding: 0;
		}
		fieldset {
			max-width: ${props => (props.wide ? "none" : "420px")};
		}
	}
	max-width: ${props => (props.narrow ? "420px" : "none")};
	width: ${props => (props.wide ? "100%" : "auto")};
	max-height: ${props => (props.limitHeight ? "90vh" : "none")};
	overflow: ${props => (props.limitHeight ? "hidden" : "visible")};
`;

const Container = styled.div<{ wide?: boolean }>`
	text-align: center;
`;

const Title = styled.div`
	h2 {
		margin: 0 0 10px 0;
	}
`;

const Close = styled.span`
	position: absolute;
	top: 5px;
	right: 5px;
	padding: 5px;
	margin: 0;
	display: inline-block;
`;

const Expand = styled.span`
	position: absolute;
	top: 5px;
	right: 30px;
	padding: 5px;
	margin: 0;
	display: inline-block;
`;

interface Props {
	title?: string;
	className?: string;
	noPadding?: boolean;
	narrow?: boolean;
	wide?: boolean;
	onClose?(event: React.SyntheticEvent | KeyboardEvent): any;
	onMaximize?(event?: React.SyntheticEvent): any;
	onMinimize?(event?: React.SyntheticEvent): any;
	maximizable?: boolean;
	limitHeight?: boolean;
}

export function Dialog(props: PropsWithChildren<Props>) {
	const [expanded, setExpanded] = React.useState(false);
	const disposables: { dispose(): void }[] = [];

	useDidMount(() => {
		if (props.onClose) {
			disposables.push(
				KeystrokeDispatcher.withLevel(),
				KeystrokeDispatcher.onKeyDown(
					"Escape",
					(event: KeyboardEvent) => {
						if (props.onClose) {
							event.stopPropagation();
							props.onClose(event);
						}
					},
					{ source: "Dialog.tsx", level: -1 }
				)
			);
		}

		return () => {
			disposables && disposables.forEach(_ => _.dispose());
		};
	});
	return expanded ? (
		<Modal noPadding>
			{props.title && (
				<Title>
					<CSText as="h2">{props.title}</CSText>
				</Title>
			)}
			<Expand>
				<Icon
					className="clickable"
					name="minimize"
					onClick={() => {
						setExpanded(false);
						if (props.onMinimize) props.onMinimize();
					}}
				/>
			</Expand>
			{props.onClose && (
				<Tooltip
					placement="left"
					overlayStyle={{ zIndex: "3000" }}
					title={
						<span>
							Close <span className="keybinding">ESC</span>
						</span>
					}
				>
					<Close className="close">
						<Icon className="clickable" name="x" onClick={props.onClose} />
					</Close>
				</Tooltip>
			)}
			<div className="expanded">{props.children}</div>
		</Modal>
	) : (
		<Container>
			<Box
				className={props.className}
				narrow={props.narrow}
				wide={props.wide}
				noPadding={props.noPadding}
				limitHeight={props.limitHeight}
			>
				{props.title && (
					<Title>
						<CSText as="h2">{props.title}</CSText>
					</Title>
				)}
				{props.maximizable && (
					<Expand>
						<Icon
							className="clickable"
							name="maximize"
							onClick={() => {
								setExpanded(true);
								if (props.onMaximize) props.onMaximize();
							}}
						/>
					</Expand>
				)}
				{props.onClose && (
					<Tooltip
						placement="left"
						overlayStyle={{ zIndex: "3000" }}
						title={
							<span>
								Close <span className="keybinding">ESC</span>
							</span>
						}
					>
						<Close className="close">
							<Icon className="clickable" name="x" onClick={props.onClose} />
						</Close>
					</Tooltip>
				)}
				{props.children}
			</Box>
		</Container>
	);
}
