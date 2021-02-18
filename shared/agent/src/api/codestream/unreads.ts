"use strict";
import { Emitter, Event } from "vscode-languageserver";
import { Container, SessionContainer } from "../../container";
import { Logger } from "../../logger";
import { Unreads } from "../../protocol/agent.protocol";
import { CSLastReads, CSPost, CSStream, StreamType } from "../../protocol/api.protocol";
import { Arrays, Functions, log } from "../../system";
import { ApiProvider } from "../apiProvider";

export class CodeStreamUnreads {
	private _onDidChange = new Emitter<Unreads>();
	get onDidChange(): Event<Unreads> {
		return this._onDidChange.event;
	}

	private _lastReads: CSLastReads = Object.create(null);
	private _lastReadItems: CSLastReads = Object.create(null);
	private _mentions: { [streamId: string]: number } = Object.create(null);
	private _unreads: { [streamId: string]: number } = Object.create(null);

	constructor(private readonly _api: ApiProvider) {}

	private _computePromise: Promise<void> | undefined;
	@log()
	async compute(lastReads: CSLastReads | undefined, lastReadItems: CSLastReads | undefined) {
		if (this._computePromise !== undefined) {
			await this._computePromise;
		}

		this._computePromise = this.computeCore(lastReads, lastReadItems);
		return this._computePromise;
	}

	async get(): Promise<Unreads> {
		if (this._computePromise !== undefined) {
			await this._computePromise;
		}
		return this.values();
	}

	async update(posts: CSPost[]) {
		// Don't increment unreads for deleted, edited (if edited it isn't the first time its been seen), has replies (same as edited), or was posted by the current user
		posts = posts.filter(
			p =>
				!p.deactivated &&
				!p.hasBeenEdited &&
				p.numReplies === 0 &&
				p.creatorId !== this._api.userId &&
				(p.reactions == null || Object.keys(p.reactions).length === 0)
		);
		if (posts.length === 0) return;

		if (this._computePromise !== undefined) {
			await this._computePromise;
		}

		Logger.debug(`Unreads.update:`, `Updating unreads for ${posts.length} posts...`);

		const grouped = Arrays.groupBy(posts, p => p.streamId);
		const streams = (
			await SessionContainer.instance().streams.get({
				streamIds: Object.keys(grouped)
			})
		).streams;

		for (const [streamId, posts] of Object.entries(grouped)) {
			const { preferences } = await this._api.getPreferences();
			if (preferences.mutedStreams && preferences.mutedStreams[streamId]) continue;

			const stream = streams.find(s => s.id === streamId);
			if (stream == null) continue;

			this._mentions[streamId] = this._mentions[streamId] || 0;
			this._unreads[streamId] = this._unreads[streamId] || 0;

			Logger.debug(
				`Unreads.update(${streamId}):`,
				`Before: mentions=${this._mentions[streamId]}, unreads=${this._unreads[streamId]}`
			);

			this.computeForPosts(posts, this._api.userId, stream);

			if (this._lastReads[streamId] === undefined) {
				this._lastReads[streamId] = Number(posts[0].seqNum) - 1;
			}

			Logger.debug(
				`Unreads.update(${streamId}):`,
				`After: mentions=${this._mentions[streamId]}, unreads=${this._unreads[streamId]}`
			);
		}

		const values = this.values();
		Logger.debug(`Unreads.update:`, `Completed; values=${JSON.stringify(values)}`);

		this._onDidChange.fire(values);
	}

	private async computeCore(
		lastReads: CSLastReads | undefined,
		lastReadItems: CSLastReads | undefined
	) {
		if (lastReads === undefined) {
			lastReads = Object.create(null) as CSLastReads;
		}

		if (lastReadItems === undefined) {
			lastReadItems = Object.create(null) as CSLastReads;
		}

		// Reset the counters
		this._unreads = Object.create(null);
		this._mentions = Object.create(null);

		Logger.debug(`Unreads.compute:`, "Computing...");

		const unreadStreams = (await SessionContainer.instance().streams.getUnread()).streams;
		if (unreadStreams.length !== 0) {
			const entries = Object.entries(lastReads);

			const { posts } = SessionContainer.instance();

			await Promise.all(
				entries.map(async ([streamId, lastReadSeqNum]) => {
					const { preferences } = await this._api.getPreferences();
					if (Functions.safe(() => preferences.mutedStreams[streamId] === true)) return;

					const stream = unreadStreams.find(stream => stream.id === streamId);
					if (stream == null) return;

					let latestPost;
					let unreadPosts;
					try {
						latestPost = (
							await posts.get({
								streamId: streamId,
								limit: 1
							})
						).posts[0];
						unreadPosts = (
							await posts.get({
								streamId: streamId,
								before: latestPost.seqNum,
								after: Number(lastReadSeqNum) + 1,
								inclusive: true
							})
						).posts;
						unreadPosts = unreadPosts.filter(
							p => !p.deactivated && p.creatorId !== this._api.userId
						);
					} catch (ex) {
						// likely an access error because user is no longer in this channel
						debugger;
						Logger.error(ex);
						return;
					}

					if (unreadPosts != null && unreadPosts.length !== 0) {
						this._mentions[streamId] = this._mentions[streamId] || 0;
						this._unreads[streamId] = this._unreads[streamId] || 0;

						this.computeForPosts(unreadPosts, this._api.userId, stream);

						Logger.debug(
							`Unreads.compute(${streamId}):`,
							`mentions=${this._mentions[streamId]}, unreads=${this._unreads[streamId]}`
						);
					}
				})
			);
		}

		this._lastReads = lastReads;
		this._lastReadItems = lastReadItems;
		this._computePromise = undefined;

		const values = this.values();
		Logger.debug(`Unreads.compute:`, `Completed; values=${JSON.stringify(values)}`);

		this._onDidChange.fire(values);
	}

	private computeForPosts(posts: CSPost[], userId: string, stream?: CSStream) {
		for (const post of posts) {
			if (
				(stream && stream.type) === StreamType.Direct ||
				(post.mentionedUserIds || []).includes(userId)
			) {
				this._mentions[post.streamId]++;
			}
			this._unreads[post.streamId]++;
		}
	}

	private values(): Unreads {
		return {
			lastReads: this._lastReads,
			lastReadItems: this._lastReadItems,
			mentions: this._mentions,
			unreads: this._unreads,
			totalMentions: Object.values(this._mentions).reduce((total, count) => total + count, 0),
			totalUnreads: Object.values(this._unreads).reduce((total, count) => total + count, 0)
		};
	}
}
