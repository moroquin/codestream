"use strict";
import { GraphQLClient } from "graphql-request";
import { flatten, groupBy } from "lodash-es";
import { Response } from "node-fetch";
import * as paths from "path";
import * as qs from "querystring";
import { URI } from "vscode-uri";
import { SessionContainer } from "../container";
import { GitRemoteLike } from "../git/models/remote";
import { GitRepository } from "../git/models/repository";
import { toRepoName } from "../git/utils";
import { Logger } from "../logger";

import { InternalError, ReportSuppressedMessages } from "../agentError";

import {
	CreateThirdPartyCardRequest,
	DidChangePullRequestCommentsNotificationType,
	DocumentMarker,
	FetchThirdPartyBoardsRequest,
	FetchThirdPartyBoardsResponse,
	FetchThirdPartyCardsRequest,
	FetchThirdPartyCardsResponse,
	FetchThirdPartyPullRequestCommitsRequest,
	FetchThirdPartyPullRequestCommitsResponse,
	FetchThirdPartyPullRequestFilesResponse,
	GetMyPullRequestsRequest,
	GetMyPullRequestsResponse,
	GitLabBoard,
	GitLabCreateCardRequest,
	GitLabCreateCardResponse,
	MoveThirdPartyCardRequest
} from "../protocol/agent.protocol";
import { CSGitLabProviderInfo } from "../protocol/api.protocol";
import { log, lspProvider, Strings } from "../system";
import {
	getRemotePaths,
	ProviderCreatePullRequestRequest,
	ProviderCreatePullRequestResponse,
	ProviderGetRepoInfoResponse,
	PullRequestComment,
	REFRESH_TIMEOUT,
	ThirdPartyIssueProviderBase
} from "./provider";
import { Directives } from "./directives";

interface GitLabProject {
	path_with_namespace: any;
	id: string;
	path: string;
	issues_enabled: boolean;
}

interface GitLabUser {
	id: string;
	name: string;
	avatar_url: string;
}

@lspProvider("gitlab")
export class GitLabProvider extends ThirdPartyIssueProviderBase<CSGitLabProviderInfo> {
	private _gitlabUserId: string | undefined;
	private _projectsByRemotePath = new Map<string, GitLabProject>();

	get displayName() {
		return "GitLab";
	}

	get name() {
		return "gitlab";
	}

	get headers(): any {
		return {
			Authorization: `Bearer ${this.accessToken}`,
			"Content-Type": "application/json"
		};
	}

	protected getPRExternalContent(comment: PullRequestComment) {
		return {
			provider: {
				name: this.displayName,
				icon: "gitlab",
				id: this.providerConfig.id
			},
			subhead: `#${comment.pullRequest.id}`,
			actions: [
				{
					label: "Open Note",
					uri: comment.url
				},
				{
					label: `Open Merge Request #${comment.pullRequest.id}`,
					uri: comment.pullRequest.url
				}
			]
		};
	}

	async onConnected(providerInfo?: CSGitLabProviderInfo) {
		super.onConnected(providerInfo);
		this._gitlabUserId = await this.getMemberId();
		this._projectsByRemotePath = new Map<string, GitLabProject>();
	}

	@log()
	async getBoards(request: FetchThirdPartyBoardsRequest): Promise<FetchThirdPartyBoardsResponse> {
		await this.ensureConnected();
		const openProjects = await this.getOpenProjectsByRemotePath();

		let boards: GitLabBoard[];
		if (openProjects.size > 0) {
			const gitLabProjects = Array.from(openProjects.values());
			boards = gitLabProjects
				.filter(p => p.issues_enabled)
				.map(p => ({
					id: p.id,
					name: p.path_with_namespace,
					path: p.path,
					singleAssignee: true // gitlab only allows a single assignee per issue (at least it only shows one in the UI)
				}));
		} else {
			let gitLabProjects: { [key: string]: string }[] = [];
			try {
				let apiResponse = await this.get<{ [key: string]: string }[]>(
					`/projects?min_access_level=20&with_issues_enabled=true`
				);
				gitLabProjects = apiResponse.body;

				let nextPage: string | undefined;
				while ((nextPage = this.nextPage(apiResponse.response))) {
					apiResponse = await this.get<{ [key: string]: string }[]>(nextPage);
					gitLabProjects = gitLabProjects.concat(apiResponse.body);
				}
			} catch (err) {
				Logger.error(err);
				debugger;
			}
			boards = gitLabProjects.map(p => {
				return {
					...p,
					id: p.id,
					name: p.path_with_namespace,
					path: p.path,
					singleAssignee: true // gitlab only allows a single assignee per issue (at least it only shows one in the UI)
				};
			});
		}

		return {
			boards
		};
	}

	private async getOpenProjectsByRemotePath() {
		const { git } = SessionContainer.instance();
		const gitRepos = await git.getRepositories();
		const openProjects = new Map<string, GitLabProject>();

		for (const gitRepo of gitRepos) {
			const remotes = await git.getRepoRemotes(gitRepo.path);
			for (const remote of remotes) {
				if (this.getIsMatchingRemotePredicate()(remote) && !openProjects.has(remote.path)) {
					let gitlabProject = this._projectsByRemotePath.get(remote.path);

					if (!gitlabProject) {
						try {
							const response = await this.get<GitLabProject>(
								`/projects/${encodeURIComponent(remote.path)}`
							);
							gitlabProject = {
								...response.body,
								path: gitRepo.path
							};
							this._projectsByRemotePath.set(remote.path, gitlabProject);
						} catch (err) {
							Logger.error(err);
							debugger;
						}
					}

					if (gitlabProject) {
						openProjects.set(remote.path, gitlabProject);
					}
				}
			}
		}
		return openProjects;
	}

	@log()
	async createCard(request: CreateThirdPartyCardRequest) {
		await this.ensureConnected();

		const data = request.data as GitLabCreateCardRequest;
		const card: { [key: string]: any } = {
			title: data.title,
			description: data.description
		};
		if (data.assignee) {
			// GitLab allows for multiple assignees in the API, but only one appears in the UI
			card.assignee_ids = [data.assignee.id];
		}
		const response = await this.post<{}, GitLabCreateCardResponse>(
			`/projects/${encodeURIComponent(data.repoName)}/issues?${qs.stringify(card)}`,
			{}
		);
		return { ...response.body, url: response.body.web_url };
	}

	// FIXME
	@log()
	async moveCard(request: MoveThirdPartyCardRequest) {}

	@log()
	async getCards(request: FetchThirdPartyCardsRequest): Promise<FetchThirdPartyCardsResponse> {
		await this.ensureConnected();

		const { body } = await this.get<any[]>(
			`/issues?${qs.stringify({
				state: "opened",
				scope: "assigned_to_me"
			})}`
		);
		const cards = body.map(card => {
			return {
				id: card.id,
				url: card.web_url,
				title: card.title,
				modifiedAt: new Date(card.updated_at).getTime(),
				tokenId: card.iid,
				body: card.description
			};
		});
		return { cards };
	}

	private async getMemberId() {
		const userResponse = await this.get<{ id: string; [key: string]: any }>(`/user`);
		return userResponse.body.id;
	}

	private nextPage(response: Response): string | undefined {
		const linkHeader = response.headers.get("Link") || "";
		if (linkHeader.trim().length === 0) return undefined;
		const links = linkHeader.split(",");
		for (const link of links) {
			const [rawUrl, rawRel] = link.split(";");
			const url = rawUrl.trim();
			const rel = rawRel.trim();
			if (rel === `rel="next"`) {
				const baseUrl = this.baseUrl;
				return url.substring(1, url.length - 1).replace(baseUrl, "");
			}
		}
		return undefined;
	}

	@log()
	async getAssignableUsers(request: { boardId: string }) {
		await this.ensureConnected();

		const response = await this.get<GitLabUser[]>(`/projects/${request.boardId}/users`);
		return { users: response.body.map(u => ({ ...u, displayName: u.name })) };
	}

	@log()
	async getPullRequestDocumentMarkers({
		uri,
		repoId,
		streamId
	}: {
		uri: URI;
		repoId: string | undefined;
		streamId: string;
	}): Promise<DocumentMarker[]> {
		return super.getPullRequestDocumentMarkersCore({ uri, repoId, streamId });
	}

	private _commentsByRepoAndPath = new Map<
		string,
		{ expiresAt: number; comments: Promise<PullRequestComment[]> }
	>();

	private _isMatchingRemotePredicate = (r: GitRemoteLike) => r.domain === "gitlab.com";
	getIsMatchingRemotePredicate() {
		return this._isMatchingRemotePredicate;
	}

	async getRemotePaths(repo: any, _projectsByRemotePath: any) {
		// TODO don't need this ensureConnected -- doesn't hit api
		await this.ensureConnected();
		const remotePaths = await getRemotePaths(
			repo,
			this.getIsMatchingRemotePredicate(),
			_projectsByRemotePath
		);
		return remotePaths;
	}

	protected getOwnerFromRemote(remote: string): { owner: string; name: string } {
		// HACKitude yeah, sorry
		const uri = URI.parse(remote);
		const split = uri.path.split("/");

		// the project name is the last item
		let name = split.pop();
		// gitlab & enterprise can use project groups + subgroups
		const owner = split.filter(_ => _ !== "" && _ != null);
		if (name != null) {
			name = toRepoName(name);
		}

		return {
			owner: owner.join("/"),
			name: name!
		};
	}

	@log()
	async createPullRequest(
		request: ProviderCreatePullRequestRequest
	): Promise<ProviderCreatePullRequestResponse | undefined> {
		try {
			void (await this.ensureConnected());

			if (!(await this.isPRApiCompatible())) {
				return {
					error: {
						type: "UNKNOWN",
						message: "PR Api is not compatible"
					}
				};
			}
			const { owner, name } = this.getOwnerFromRemote(request.remote);

			const repoInfo = await this.getRepoInfo({ remote: request.remote });
			if (repoInfo && repoInfo.error) {
				return {
					error: repoInfo.error
				};
			}

			const createPullRequestResponse = await this.post<
				GitLabCreateMergeRequestRequest,
				GitLabCreateMergeRequestResponse
			>(
				`/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests`,
				{
					title: request.title,
					source_branch: request.headRefName,
					target_branch: request.baseRefName,
					description: this.createDescription(request)
				},
				{
					// couldn't get this post to work without
					// this additional header
					"Content-Type": "application/json"
				}
			);
			const title = `#${createPullRequestResponse.body.iid} ${createPullRequestResponse.body.title}`;

			return {
				title: title,
				url: createPullRequestResponse.body.web_url
			};
		} catch (ex) {
			Logger.error(ex, `${this.displayName}: createPullRequest`, {
				remote: request.remote,
				baseRefName: request.baseRefName,
				headRefName: request.headRefName
			});
			return {
				error: {
					type: "PROVIDER",
					message: `${this.displayName}: ${ex.message}`
				}
			};
		}
	}

	async getRepoInfo(request: { remote: string }): Promise<ProviderGetRepoInfoResponse> {
		let owner;
		let name;
		try {
			({ owner, name } = this.getOwnerFromRemote(request.remote));

			let projectResponse;
			try {
				projectResponse = await this.get<GitLabProjectInfoResponse>(
					`/projects/${encodeURIComponent(`${owner}/${name}`)}`
				);
			} catch (ex) {
				Logger.error(ex, `${this.displayName}: failed to get projects`, {
					owner: owner,
					name: name,
					hasProviderInfo: this._providerInfo != null
				});
				return {
					error: {
						type: "PROVIDER",
						message: ex.message
					}
				};
			}
			let mergeRequestsResponse;
			try {
				mergeRequestsResponse = await this.get<GitLabMergeRequestInfoResponse[]>(
					`/projects/${encodeURIComponent(`${owner}/${name}`)}/merge_requests?state=opened`
				);
			} catch (ex) {
				Logger.error(ex, `${this.displayName}: failed to get merge_requests`, {
					owner: owner,
					name: name,
					hasProviderInfo: this._providerInfo != null
				});
				return {
					error: {
						type: "PROVIDER",
						message: ex.message
					}
				};
			}

			return {
				id: (projectResponse.body.iid || projectResponse.body.id)!.toString(),
				defaultBranch: projectResponse.body.default_branch,
				pullRequests: mergeRequestsResponse.body.map(_ => {
					return {
						id: JSON.stringify({ full: _.references.full, id: _.iid.toString() }),
						iid: _.iid.toString(),
						url: _.web_url,
						baseRefName: _.target_branch,
						headRefName: _.source_branch
					};
				})
			};
		} catch (ex) {
			Logger.error(ex, `${this.displayName}: getRepoInfo failed`, {
				owner: owner,
				name: name,
				hasProviderInfo: this._providerInfo != null
			});

			return {
				error: {
					type: "PROVIDER",
					message: ex.message
				}
			};
		}
	}

	@log()
	protected async getCommentsForPath(
		filePath: string,
		repo: GitRepository
	): Promise<PullRequestComment[] | undefined> {
		const cc = Logger.getCorrelationContext();

		try {
			const relativePath = Strings.normalizePath(paths.relative(repo.path, filePath));
			const cacheKey = `${repo.path}|${relativePath}`;

			const cachedComments = this._commentsByRepoAndPath.get(cacheKey);
			if (cachedComments !== undefined && cachedComments.expiresAt > new Date().getTime()) {
				// NOTE: Keep this await here, so any errors are caught here
				return await cachedComments.comments;
			}
			super.invalidatePullRequestDocumentMarkersCache();

			const remotePaths = await getRemotePaths(
				repo,
				this.getIsMatchingRemotePredicate(),
				this._projectsByRemotePath
			);

			const commentsPromise: Promise<PullRequestComment[]> =
				remotePaths != null
					? this._getCommentsForPathCore(filePath, relativePath, remotePaths)
					: Promise.resolve([]);
			this._commentsByRepoAndPath.set(cacheKey, {
				expiresAt: new Date().setMinutes(new Date().getMinutes() + REFRESH_TIMEOUT),
				comments: commentsPromise
			});

			// Since we aren't cached, we want to just kick of the request to get the comments (which will fire a notification)
			// This could probably be enhanced to wait for the commentsPromise for a short period of time (maybe 1s?) to see if it will complete, to avoid the notification roundtrip for fast requests
			return undefined;
		} catch (ex) {
			Logger.error(ex, cc);
			return undefined;
		}
	}

	private async _getCommentsForPathCore(
		filePath: string,
		relativePath: string,
		remotePaths: string[]
	): Promise<PullRequestComment[]> {
		const comments = [];

		for (const remotePath of remotePaths) {
			const prs = await this._getPullRequests(remotePath);

			const prComments = (
				await Promise.all(prs.map(pr => this._getPullRequestComments(remotePath, pr, relativePath)))
			).reduce((group, current) => group.concat(current), []);

			comments.push(...prComments);
		}

		// If we have any comments, fire a notification
		if (comments.length !== 0) {
			void SessionContainer.instance().documentMarkers.fireDidChangeDocumentMarkers(
				URI.file(filePath).toString(),
				"codemarks"
			);
		}

		return comments;
	}

	private async _getPullRequests(remotePath: string): Promise<GitLabPullRequest[]> {
		return flatten(
			await Promise.all([
				this._getPullRequestsByState(remotePath, "opened"),
				this._getPullRequestsByState(remotePath, "merged")
			])
		);
	}

	private async _getPullRequestsByState(
		remotePath: string,
		state: string
	): Promise<GitLabPullRequest[]> {
		const prs: GitLabPullRequest[] = [];

		try {
			let url: string | undefined = `/projects/${encodeURIComponent(
				remotePath
			)}/merge_requests?state=${state}`;
			do {
				const apiResponse = await this.get<GitLabPullRequest[]>(url);
				prs.push(...apiResponse.body);
				url = this.nextPage(apiResponse.response);
			} while (url);
		} catch (ex) {
			Logger.error(ex);
		}

		prs.forEach(pr => (pr.number = pr.iid));
		return prs;
	}

	private async _getPullRequestComments(
		remotePath: string,
		pr: GitLabPullRequest,
		relativePath: string
	): Promise<PullRequestComment[]> {
		let gitLabComments: GitLabPullRequestComment[] = [];

		try {
			let apiResponse = await this.get<GitLabPullRequestComment[]>(
				`/projects/${encodeURIComponent(remotePath)}/merge_requests/${pr.iid}/notes`
			);
			gitLabComments = apiResponse.body;

			let nextPage: string | undefined;
			while ((nextPage = this.nextPage(apiResponse.response))) {
				apiResponse = await this.get<GitLabPullRequestComment[]>(nextPage);
				gitLabComments = gitLabComments.concat(apiResponse.body);
			}
		} catch (ex) {
			Logger.error(ex);
		}

		return gitLabComments
			.filter(c => !c.system && c.position != null && c.position.new_path === relativePath)
			.map(glComment => {
				return {
					id: glComment.id.toString(),
					author: {
						id: glComment.author.id.toString(),
						nickname: glComment.author.name
					},
					path: glComment.position.new_path,
					text: glComment.body,
					code: "",
					commit: glComment.position.head_sha,
					originalCommit: glComment.position.base_sha,
					line: glComment.position.new_line,
					originalLine: glComment.position.old_line,
					url: `${pr.web_url}#note_${glComment.id}`,
					createdAt: new Date(glComment.created_at).getTime(),
					pullRequest: {
						id: pr.iid,
						url: pr.web_url,
						isOpen: pr.state === "opened",
						targetBranch: pr.target_branch,
						sourceBranch: pr.source_branch
					}
				};
			});
	}

	async getMyPullRequests(
		request: GetMyPullRequestsRequest
	): Promise<GetMyPullRequestsResponse[][] | undefined> {
		void (await this.ensureConnected());

		let repoQuery =
			request && request.owner && request.repo ? `repo:${request.owner}/${request.repo} ` : "";
		if (request.isOpen) {
			try {
				const { scm, providerRegistry } = SessionContainer.instance();
				const reposResponse = await scm.getRepos({ inEditorOnly: true, includeProviders: true });
				const repos = [];
				if (reposResponse?.repositories) {
					for (const repo of reposResponse.repositories) {
						if (repo.remotes) {
							for (const remote of repo.remotes) {
								const urlToTest = `anything://${remote.domain}/${remote.path}`;
								const results = await providerRegistry.queryThirdParty({ url: urlToTest });
								if (results && results.providerId === this.providerConfig.id) {
									const ownerData = this.getOwnerFromRemote(urlToTest);
									if (ownerData) {
										repos.push(`${ownerData.owner}/${ownerData.name}`);
									}
								}
							}
						}
					}
				}
				if (repos.length) {
					repoQuery = repos.map(_ => `repo:${_}`).join(" ") + " ";
				} else {
					Logger.log(`getMyPullRequests: request.isOpen=true, but no repos found, returning empty`);
					return [];
				}
			} catch (ex) {
				Logger.error(ex);
			}
		}

		let queries = request.queries;

		// https://docs.gitlab.com/ee/api/merge_requests.html
		const items = await Promise.all(
			queries.map(_ => {
				const exploded = _.split(" ")
					.map(q => {
						const kvp = q.split(":");
						return `${encodeURIComponent(kvp[0])}=${encodeURIComponent(kvp[1])}`;
					})
					.join("&");

				return this.get<any>(`/merge_requests/?${exploded}&with_labels_details=true`);
			})
		).catch(ex => {
			Logger.error(ex);
			let errString;
			if (ex.response) {
				errString = JSON.stringify(ex.response);
			} else {
				errString = ex.message;
			}
			throw new Error(errString);
		});
		const response: any[][] = [];
		items.forEach((item: any, index) => {
			if (item && item.body) {
				response[index] = item.body
					.filter((_: any) => _.id)
					.map((pr: { created_at: string; id: string; iid: string }) => ({
						...pr,
						id: `gid://gitlab/MergeRequest/${pr.id}`,
						providerId: this.providerConfig?.id,
						createdAt: new Date(pr.created_at).getTime(),
						number: parseInt(pr.iid, 10)
					}));

				if (!queries[index].match(/\bsort:/)) {
					response[index] = response[index].sort(
						(a: { created_at: number }, b: { created_at: number }) => b.created_at - a.created_at
					);
				}
			}
		});

		return response;
	}

	get graphQlBaseUrl() {
		return `${this.baseUrl.replace("/v4", "")}/graphql`;
	}

	protected _client: GraphQLClient | undefined;
	protected async client(): Promise<GraphQLClient> {
		if (this._client === undefined) {
			this._client = new GraphQLClient(this.graphQlBaseUrl);
		}
		if (!this.accessToken) {
			throw new Error("Could not get a GitLab personal access token");
		}

		this._client.setHeaders({
			Authorization: `Bearer ${this.accessToken}`
		});

		return this._client;
	}

	_isSuppressedException(ex: any): ReportSuppressedMessages | undefined {
		const networkErrors = [
			"ENOTFOUND",
			"ETIMEDOUT",
			"EAI_AGAIN",
			"ECONNRESET",
			"ECONNREFUSED",
			"ENETDOWN",
			"ENETUNREACH",
			"socket disconnected before secure",
			"socket hang up"
		];

		if (ex.message && networkErrors.some(e => ex.message.match(new RegExp(e)))) {
			return ReportSuppressedMessages.NetworkError;
		} else if (ex.message && ex.message.match(/GraphQL Error \(Code: 404\)/)) {
			return ReportSuppressedMessages.ConnectionError;
		} else if (
			(ex.response && ex.response.message === "Bad credentials") ||
			(ex.response &&
				ex.response.errors instanceof Array &&
				ex.response.errors.find((e: any) => e.type === "FORBIDDEN"))
		) {
			return ReportSuppressedMessages.AccessTokenInvalid;
		} else {
			return undefined;
		}
	}

	_queryLogger: {
		restApi: {
			rateLimit?: { remaining: number; limit: number; used: number; reset: number };
			fns: any;
		};
		graphQlApi: {
			rateLimit?: {
				remaining: number;
				resetAt: string;
				resetInMinutes: number;
				last?: { name: string; cost: number };
			};
			fns: any;
		};
	} = {
		graphQlApi: { fns: {} },
		restApi: { fns: {} }
	};
	async query<T = any>(query: string, variables: any = undefined) {
		if (this._providerInfo && this._providerInfo.tokenError) {
			delete this._client;
			throw new InternalError(ReportSuppressedMessages.AccessTokenInvalid);
		}

		let response;
		try {
			response = await (await this.client()).request<any>(query, variables);
		} catch (ex) {
			Logger.warn("GitLab query caught:", ex);
			const exType = this._isSuppressedException(ex);
			if (exType !== undefined) {
				if (exType !== ReportSuppressedMessages.NetworkError) {
					// we know about this error, and we want to give the user a chance to correct it
					// (but throwing up a banner), rather than logging the error to sentry
					this.session.api.setThirdPartyProviderInfo({
						providerId: this.providerConfig.id,
						data: {
							tokenError: {
								error: ex,
								occurredAt: Date.now(),
								isConnectionError: exType === ReportSuppressedMessages.ConnectionError
							}
						}
					});
					delete this._client;
				}
				// this throws the error but won't log to sentry (for ordinary network errors that seem temporary)
				throw new InternalError(exType, { error: ex });
			} else {
				// this is an unexpected error, throw the exception normally
				throw ex;
			}
		}

		return response;
	}

	async mutate<T>(query: string, variables: any = undefined) {
		return (await this.client()).request<T>(query, variables);
	}

	async restGet<T extends object>(url: string) {
		return this.get<T>(url);
	}

	async restPost<T extends object, R extends object>(url: string, variables: any) {
		return this.post<T, R>(url, variables);
	}

	async restPut<T extends object, R extends object>(url: string, variables: any) {
		return this.put<T, R>(url, variables);
	}
	async restDelete<R extends object>(url: string, options: { useRawResponse: boolean }) {
		return this.delete<R>(url, {}, options);
	}

	_gitlabUsername?: string;

	_pullRequestCache: Map<
		string,
		// TODO fix this up -- there's a definition below
		any
		// {
		// 	project: {
		// 		name: string;
		// 		mergeRequest: {
		// 			id: string;
		// 			iid: string;
		// 		};
		// 	};
		// }
	> = new Map();

	async getReviewers(request: { pullRequestId: string }) {
		let projectFullPath;
		let iid;
		let actualPullRequestId;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			actualPullRequestId = parsed.id;
			projectFullPath = parsed.full.split("!")[0];
			iid = parsed.full.split("!")[1];
		}

		const response = await this.restGet<GitLabUser[]>(
			`/projects/${encodeURIComponent(projectFullPath)}/users`
		);
		return {
			users: response.body.map(u => ({ ...u, avatarUrl: u.avatar_url, displayName: u.name }))
		};
	}

	@log()
	async getPullRequest(request: { pullRequestId: string; force?: boolean }): Promise<any> {
		let projectFullPath;
		let iid;
		let actualPullRequestId;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			actualPullRequestId = parsed.id;
			projectFullPath = parsed.full.split("!")[0];
			iid = parsed.full.split("!")[1];
		}

		// const { scm: scmManager } = SessionContainer.instance();
		await this.ensureConnected();

		if (request.force) {
			this._pullRequestCache.delete(actualPullRequestId);
		} else {
			const cached = this._pullRequestCache.get(actualPullRequestId);
			if (cached) {
				return cached;
			}
		}

		let response = {} as {
			currentUser: any;
			project: {
				mergeRequest: {
					approvedBy: {
						nodes: {
							avatarUrl: string;
							name: string;
							username: string;
						};
					};
					baseRefName: string;
					baseRefOid: string;
					createdAt: string;
					diffRefs: any;
					discussions: {
						nodes: {
							createdAt: string;
							id: string;
							_pending?: boolean;
							notes?: {
								nodes: {
									id: string;
									author: {
										name: string;
										username: string;
										avatarUrl: string;
									};
									body: string;
									position: any;
									createdAt: string;
								}[];
							};
						}[];
					};
					downvotes: number;
					headRefName: string;
					headRefOid: string;
					id: string;
					idComputed: string;
					iid: string;
					merged: boolean;
					mergedAt: string;
					number: number;
					pendingReview: {
						comments: {
							totalCount: number;
						};
					};
					projectId: string;
					// CS providerId
					providerId: string;
					reactionGroups: {
						content: string;
						data: {
							awardable_id: number;
							id: number;
							name: string;
							user: {
								id: number;
								avatar_url: string;
								username: string;
							};
						}[];
					}[];
					reference: string;
					references: {
						full: string;
					};
					repository: {
						name: string;
						nameWithOwner: string;
						url: string;
					};
					sourceBranch: string;
					state: string;
					sourceProject: any;
					targetBranch: string;
					title: string;

					upvotes: number;
					url: string;
					viewer: {
						login: string;
					};
					webUrl: string;
					workInProgress: boolean;
				};
			};
		};
		try {
			const q = `query GetPullRequest($fullPath:ID!, $iid:String!) {
				currentUser {
					name
					username
					id
				}
				project(fullPath: $fullPath) {
				  name
				  mergeRequest(iid: $iid) {
					approvedBy {
						nodes {
						  avatarUrl
						  name
						  username
						}
					}
					id
					iid
					createdAt
					sourceBranch
					targetBranch
					title
					description
					webUrl
					state
					mergedAt
					workInProgress
					reference
					projectId
					author {
						name
						username
						avatarUrl
					}
					diffRefs {
						baseSha
						headSha
						startSha
					}
					commitCount
					sourceProject{
						name
						webUrl
						fullPath
					}
					upvotes
					downvotes
					milestone {
						title
						id
						webPath
						dueDate
					}
					subscribed
					userDiscussionsCount
					discussionLocked
					assignees(last: 100) {
						nodes {
						  id
						  name
						  username
						  avatarUrl
						}
					  }
					participants(last:100) {
						nodes {
						  id
						  name
						  username
						  avatarUrl
						}
					  }
					labels(last: 100) {
						nodes {
						  id
						  color
						  textColor
						  title
						}
					  }
					  currentUserTodos(last: 100) {
						nodes {
						  action
						  body
						  id
						  targetType
						  state
						}
					  }
					timeEstimate
					totalTimeSpent
					discussions {
					  nodes {
						createdAt
						id
						notes {
						  nodes {
							author {
							  name
							  username
							  avatarUrl
							}
							body
							bodyHtml
							confidential
							createdAt
							discussion {
							  id
							  replyId
							  createdAt
							}
							id
							position{
							  x
							  y
							  newLine
							  newPath
							  oldLine
							  oldPath
							  filePath
							}
							project {
							  name
							}
							resolvable
							resolved
							resolvedAt
							resolvedBy {
							  username
							  avatarUrl
							}
							system
							systemNoteIconName
							updatedAt
							userPermissions {
							  readNote
							  resolveNote
							  awardEmoji
							  createNote
							}
						  }
						}
						replyId
						resolvable
						resolved
						resolvedAt
						resolvedBy{
						  username
						  avatarUrl
						}
					  }
					}
				  }
				}
			  }`;

			response = await this.query(q, {
				fullPath: projectFullPath,
				iid: iid.toString()
			});

			response.project.mergeRequest.viewer = {
				login: response.currentUser.username
			};
			this._gitlabUsername = response.currentUser.username;
			// awards are "reactions" aka "emojis"
			const awards = await this.restGet<any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/award_emoji`
			);
			const grouped = groupBy(awards.body, (_: { name: string }) => _.name);
			response.project.mergeRequest.reactionGroups =
				Object.keys(grouped).map(_ => {
					return { content: _, data: grouped[_] };
				}) || [];
			response.project.mergeRequest.providerId = this.providerConfig?.id;
			response.project.mergeRequest.baseRefOid =
				response.project.mergeRequest.diffRefs && response.project.mergeRequest.diffRefs.baseSha;
			response.project.mergeRequest.baseRefName = response.project.mergeRequest.targetBranch;
			response.project.mergeRequest.headRefOid =
				response.project.mergeRequest.diffRefs && response.project.mergeRequest.diffRefs.headSha;
			response.project.mergeRequest.headRefName = response.project.mergeRequest.sourceBranch;
			response.project.mergeRequest.repository = {
				name: response.project.mergeRequest.sourceProject.name,
				nameWithOwner: response.project.mergeRequest.sourceProject.fullPath,
				url: response.project.mergeRequest.sourceProject.webUrl
			};
			response.project.mergeRequest.number = parseInt(response.project.mergeRequest.iid, 10);
			response.project.mergeRequest.url = response.project.mergeRequest.sourceProject.webUrl;
			response.project.mergeRequest.merged = !!response.project.mergeRequest.mergedAt;
			// build this so that it aligns with what the REST api created
			response.project.mergeRequest.references = {
				full: `${response.project.mergeRequest.sourceProject.fullPath}${response.project.mergeRequest.reference}`
			};

			const mergeRequestFullId = JSON.stringify({
				id: response.project.mergeRequest.id,
				full: response.project.mergeRequest.references.full
			});
			response.project.mergeRequest.idComputed = mergeRequestFullId;
			response.project.mergeRequest.discussions.nodes.forEach((_: any) => {
				if (_.notes && _.notes.nodes && _.notes.nodes.length) {
					_.notes.nodes.forEach((n: any) => {
						if (n.discussion && n.discussion.id) {
							// HACK hijack the "databaseId" that github uses
							n.databaseId = n.discussion.id
								.replace("gid://gitlab/DiffDiscussion/", "")
								.replace("gid://gitlab/IndividualNoteDiscussion/", "");
							n.mergeRequestIdComputed = mergeRequestFullId;
						}
					});
					_.notes.nodes[0].replies = _.notes.nodes.filter((x: any) => x.id != _.notes.nodes[0].id);
					// remove all the replies from the parent (they're now on replies)
					_.notes.nodes.length = 1;
				}
			});
			this._pullRequestCache.set(actualPullRequestId, response);
			const pendingReview = this._pendingReviewStore.get(response.project.mergeRequest.id);
			if (pendingReview) {
				response.project.mergeRequest.pendingReview = {
					comments: {
						totalCount: pendingReview.length
					}
				};
				// TODO figure out IDs, dates, author
				response.project.mergeRequest.discussions.nodes.push({
					id: "undefined",
					_pending: true,
					createdAt: new Date().toISOString(),
					notes: {
						nodes: pendingReview.map(_ => {
							return {
								_pending: true,
								// TODO get the real author
								author: {
									name: "Pending",
									username: "pending",
									avatarUrl: "https://about.gitlab.com/images/press/logo/png/gitlab-icon-rgb.png"
								},
								state: "PENDING",
								body: _.text,
								bodyText: _.text,
								createdAt: new Date().toISOString(),
								id: "undefined",
								position: {
									oldPath: _.filePath,
									newPath: _.filePath,
									newLine: _.startLine
								}
							};
						})
					}
				});
			}

			(
				await Promise.all([
					this._projectEvents(projectFullPath, iid),
					this._labelEvents(projectFullPath, iid),
					this._milestoneEvents(projectFullPath, iid)
				]).catch(ex => {
					Logger.error(ex);
					throw ex;
				})
			).forEach(_ => response.project.mergeRequest.discussions.nodes.push(..._));

			response.project.mergeRequest.discussions.nodes.sort((a: any, b: any) =>
				a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
			);
		} catch (ex) {
			Logger.error(ex);
		}

		return response;

		// if (response?.repository?.pullRequest) {
		// 	const { repos } = SessionContainer.instance();
		// 	const prRepo = await this.getPullRequestRepo(
		// 		await repos.get(),
		// 		response.repository.pullRequest
		// 	);

		// 	if (prRepo?.id) {
		// 		try {
		// 			const prForkPointSha = await scmManager.getForkPointRequestType({
		// 				repoId: prRepo.id,
		// 				baseSha: response.repository.pullRequest.baseRefOid,
		// 				headSha: response.repository.pullRequest.headRefOid
		// 			});

		// 			response.repository.pullRequest.forkPointSha = prForkPointSha?.sha;
		// 		} catch (err) {
		// 			Logger.error(err, `Could not find forkPoint for repoId=${prRepo.id}`);
		// 		}
		// 	}
		// }
		// if (response?.repository?.pullRequest?.timelineItems != null) {
		// 	response.repository.pullRequest.timelineItems.nodes = allTimelineItems;
		// }
		// response.repository.pullRequest.repoUrl = response.repository.url;
		// response.repository.pullRequest.baseUrl = response.repository.url.replace(
		// 	response.repository.resourcePath,
		// 	""
		// );
	}

	@log()
	async createCommentReply(request: { pullRequestId: string; commentId: string; text: string }) {
		let projectFullPath;
		let iid;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			projectFullPath = parsed.full.split("!")[0];
			iid = parsed.full.split("!")[1];
		}

		const data = await this.restPost(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/discussions/${
				request.commentId
			}/notes`,
			{
				body: request.text
			}
		);
		return data.body;
	}

	private _pendingReviewStore: Map<string, any[]> = new Map<string, any[]>();

	@log()
	async getPullRequestReviewId(request: { pullRequestId: string }) {
		let actualPullRequestId;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			actualPullRequestId = parsed.id;
		}
		const existing = this._pendingReviewStore.has(actualPullRequestId);
		return existing;
	}

	async createPullRequestInlineReviewComment(request: {
		pullRequestId: string;
		text: string;
		filePath: string;
		startLine?: number;
		position: number;
		leftSha?: string;
		sha?: string;
	}) {
		const result = await this.createPullRequestReviewComment(request);
		return result;
	}

	async createPullRequestReviewComment(request: {
		pullRequestId: string;
		pullRequestReviewId?: string;
		text: string;
		filePath?: string;
		startLine?: number;
		position?: number;
		leftSha?: string;
		sha?: string;
	}) {
		let actualPullRequestId;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			actualPullRequestId = parsed.id;
		}

		if (this._pendingReviewStore.has(actualPullRequestId)) {
			const existingPendingReviews = this._pendingReviewStore.get(actualPullRequestId);
			let newPendingReviews = existingPendingReviews || [];
			newPendingReviews.push({
				request
			});
			this._pendingReviewStore.set(actualPullRequestId, newPendingReviews);
		} else {
			this._pendingReviewStore.set(actualPullRequestId, [request]);
		}

		this._pullRequestCache.delete(actualPullRequestId);
		this.session.agent.sendNotification(DidChangePullRequestCommentsNotificationType, {
			pullRequestId: actualPullRequestId,
			filePath: request.filePath
		});

		return true;
	}

	async getPendingReview(request: { pullRequestId: string }) {
		let actualPullRequestId;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			actualPullRequestId = parsed.id;
		}
		return this._pendingReviewStore.has(actualPullRequestId);
	}

	async submitReview(request: {
		pullRequestId: string;
		text: string;
		eventType: string;
		// used with old servers
		pullRequestReviewId?: string;
	}) {
		let actualPullRequestId;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			actualPullRequestId = parsed.id;
		}

		// TODO add directives
		if (!request.eventType) {
			request.eventType = "COMMENT";
		}
		if (
			request.eventType !== "COMMENT" &&
			request.eventType !== "APPROVE" &&
			// for some reason I cannot get DISMISS to work...
			// request.eventType !== "DISMISS" &&
			request.eventType !== "REQUEST_CHANGES"
		) {
			throw new Error("Invalid eventType");
		}

		const existingReviewComments = this._pendingReviewStore.get(actualPullRequestId);
		if (existingReviewComments?.length) {
			for (const comment of existingReviewComments) {
				try {
					await this.createPullRequestInlineComment({
						...comment,
						pullRequestId: request.pullRequestId
					});
				} catch (ex) {
					Logger.warn(ex, "Failed to add commit");
				}
			}
			this._pendingReviewStore.set(actualPullRequestId, []);
		}

		if (request.text) {
			await this.createPullRequestComment({
				pullRequestId: request.pullRequestId,
				text: request.text,
				noteableId: actualPullRequestId
			});
		}

		return true;
	}

	async updatePullRequestSubscription(request: { pullRequestId: string; onOff: boolean }) {
		let projectFullPath;
		let iid;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			projectFullPath = parsed.full.split("!")[0];
			iid = parsed.full.split("!")[1];
		}

		const type = request.onOff ? "subscribe" : "unsubscribe";
		const data = await this.restPost<{}, { subscribed: string }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/${type}`,
			{}
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						subscribed: data.body.subscribed
					}
				}
			]
		};
	}

	parseId(pullRequestId: string) {
		const parsed = JSON.parse(pullRequestId);
		return {
			projectFullPath: parsed.full.split("!")[0],
			iid: parsed.full.split("!")[1]
		};
	}

	async lockPullRequest(request: { pullRequestId: string }): Promise<Directives> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restPut<{}, { discussion_locked: boolean }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
			{ discussion_locked: true }
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						discussionLocked: data.body.discussion_locked
					}
				}
			]
		};
	}

	async unlockPullRequest(request: { pullRequestId: string }): Promise<Directives> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restPut<{}, { discussion_locked: boolean }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
			{ discussion_locked: false }
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						discussionLocked: data.body.discussion_locked
					}
				}
			]
		};
	}

	async createToDo(request: { pullRequestId: string }): Promise<Directives> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restPost<{}, { state: string }>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/todo`,
			{}
		);

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						currentUserTodos: {
							nodes: [data.body]
						}
					}
				}
			]
		};
	}

	async markToDoDone(request: { id: string }): Promise<Directives> {
		const id = request.id.toString().replace(/.*Todo\//, "");
		const data = await this.restPost<{}, { state: string }>(`/todos/${id}/mark_as_done`, {});

		return {
			directives: [
				{
					type: "updatePullRequest",
					data: {
						currentUserTodos: {
							nodes: [data.body]
						}
					}
				}
			]
		};
	}

	async getMilestones(request: { pullRequestId: string }) {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restGet(`/projects/${encodeURIComponent(projectFullPath)}/milestones`);
		return data.body;
	}

	async getLabels(request: { pullRequestId: string }) {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		const data = await this.restGet(`/projects/${encodeURIComponent(projectFullPath)}/labels`);
		return data.body;
	}

	@log()
	async createPullRequestComment(request: {
		pullRequestId: string;
		text: string;
		noteableId?: string;
		projectFullPath?: string;
		iid?: string;
	}): Promise<Directives> {
		let noteableId;
		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			noteableId = parsed.id;
			request.projectFullPath = parsed.full.split("!")[0];
			request.iid = parsed.full.split("!")[1];
		}
		request.noteableId = noteableId;

		const response = (await this.mutate(
			`mutation CreateNote($noteableId:ID!, $body:String!, $iid:String!){
			createNote(input: {noteableId:$noteableId, body:$body}){
				clientMutationId
				note{
					project {
						mergeRequest(iid: $iid) {
							discussions(last:5) {
							nodes {
							createdAt
							id
							notes {
								nodes {
								author {
									username
									avatarUrl
								}
								body
								bodyHtml
								confidential
								createdAt
								discussion {
									id
									replyId
									createdAt
								}
								id
								position {
									x
									y
									newLine
									newPath
									oldLine
									oldPath
									filePath
								}
								project {
									name
								}
								resolvable
								resolved
								resolvedAt
								resolvedBy {
									username
									avatarUrl
								}
								system
								systemNoteIconName
								updatedAt
								userPermissions {
										readNote
										resolveNote
										awardEmoji
										createNote
									}
								}
							}
							replyId
							resolvable
							resolved
							resolvedAt
							resolvedBy {
									username
									avatarUrl
								}
							} 
						  }
						}
					  }
					id      
					body
					createdAt
					confidential
					author {
					  username
					  avatarUrl
					}
					updatedAt
					userPermissions {
					  adminNote
					  awardEmoji
					  createNote
					  readNote
					  resolveNote
					}
				  }
				}
		  }`,
			{
				noteableId: request.noteableId,
				body: request.text,
				iid: request.iid!.toString()
			}
		)) as any;

		// find the nested node/note
		const addedNode = response.createNote.note.project.mergeRequest.discussions.nodes.find(
			(_: any) => {
				return _.notes.nodes.find((n: any) => n.id === response.createNote.note.id);
			}
		);

		return {
			directives: [
				{
					type: "addNode",
					data: addedNode
				}
			]
		};
	}

	async deletePullRequestComment(request: {
		id: string;
		pullRequestId: string;
	}): Promise<Directives | undefined> {
		const noteId = request.id;
		let actualPullRequestId;

		if (request.pullRequestId) {
			const parsed = JSON.parse(request.pullRequestId);
			actualPullRequestId = parsed.id;
		}

		const query = `
				mutation DestroyNote($id:ID!) {
					destroyNote(input:{id:$id}) {
			  			clientMutationId 
			  				note {
								id
			  				}
						}
		  			}`;

		await this.mutate<any>(query, {
			id: noteId
		});

		this._pullRequestCache.delete(actualPullRequestId);
		this.session.agent.sendNotification(DidChangePullRequestCommentsNotificationType, {
			pullRequestId: actualPullRequestId,
			commentId: noteId
		});

		return {
			directives: [
				{
					type: "removeNode",
					data: {
						id: request.id
					}
				}
			]
		};
	}

	async createPullRequestCommentAndClose(request: { pullRequestId: string; text: string }) {
		const parsed = JSON.parse(request.pullRequestId);
		const projectFullPath = parsed.full.split("!")[0];
		const iid = parsed.full.split("!")[1];

		let directives: any = [];

		if (request.text) {
			const response1 = await this.createPullRequestComment({ ...request, iid: iid });
			if (response1.directives) {
				directives = directives.concat(response1.directives);
			}
		}

		// https://docs.gitlab.com/ee/api/merge_requests.html#update-mr
		const mergeRequestUpdatedResponse = await this.restPut<
			{ state_event: string },
			{
				merge_status: string;
				merged_at: any;
				state: string;
				updated_at: any;
				closed_at: any;
				closed_by: any;
			}
		>(`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`, {
			state_event: "close"
		});

		const body = mergeRequestUpdatedResponse.body;
		directives.push({
			type: "updatePullRequest",
			data: {
				mergedAt: body.merged_at,
				mergeStatus: body.merge_status,
				state: body.state,
				updatedAt: body.updated_at,
				closedAt: body.closed_at,
				closedBy: body.closed_by
			}
		});

		directives.push({
			type: "addNodes",
			data: await this._projectEvents(projectFullPath, iid)
		});

		return {
			directives: directives
		};
	}

	async createPullRequestCommentAndReopen(request: {
		pullRequestId: string;
		text: string;
	}): Promise<any> {
		const parsed = JSON.parse(request.pullRequestId);
		const projectFullPath = parsed.full.split("!")[0];
		const iid = parsed.full.split("!")[1];

		let directives: any = [];

		if (request.text) {
			const response1 = await this.createPullRequestComment({ ...request, iid: iid });
			if (response1.directives) {
				directives = directives.concat(response1.directives);
			}
		}

		// https://docs.gitlab.com/ee/api/merge_requests.html#update-mr
		const mergeRequestUpdatedResponse = await this.restPut<
			{ state_event: string },
			{
				merged_at: any;
				merge_status: string;
				state: string;
				updated_at: any;
				closed_at: any;
				closed_by: any;
			}
		>(`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`, {
			state_event: "reopen"
		});

		const body = mergeRequestUpdatedResponse.body;
		directives.push({
			type: "updatePullRequest",
			data: {
				mergedAt: body.merged_at,
				mergeStatus: body.merge_status,
				state: body.state,
				updatedAt: body.updated_at,
				closedAt: body.closed_at,
				closedBy: body.closed_by
			}
		});
		directives.push({
			type: "addNodes",
			data: await this._projectEvents(projectFullPath, iid)
		});

		return {
			directives: directives
		};
	}

	async getPullRequestCommits(
		request: FetchThirdPartyPullRequestCommitsRequest
	): Promise<FetchThirdPartyPullRequestCommitsResponse[]> {
		const parsed = JSON.parse(request.pullRequestId);
		request.pullRequestId = parsed.id;
		const projectFullPath = parsed.full.split("!")[0];
		const iid = parsed.full.split("!")[1];

		const projectFullPathEncoded = encodeURIComponent(projectFullPath);
		const url = `/projects/${projectFullPathEncoded}/merge_requests/${iid}/commits`;
		const query = await this.restGet<
			{
				author_email: string;
				author_name: string;
				authored_date: string;
				committed_date: string;
				committer_email: string;
				committer_name: string;
				created_at: string;
				id: string;
				message: string;
				parent_ids?: string[];
				short_id: string;
				title: string;
				web_url: string;
			}[]
		>(url);

		return query.body.map(_ => {
			const authorAvatarUrl = Strings.toGravatar(_.author_email);
			let commiterAvatarUrl = authorAvatarUrl;
			if (_.author_email !== _.committer_email) {
				commiterAvatarUrl = Strings.toGravatar(_.committer_email);
			}
			return {
				oid: _.id,
				abbreviatedOid: _.short_id,
				author: {
					name: _.author_name,
					avatarUrl: authorAvatarUrl,
					user: {
						login: _.author_name
					}
				},
				committer: {
					name: _.committer_name,
					avatarUrl: commiterAvatarUrl,
					user: {
						login: _.committer_name
					}
				},
				message: _.message,
				authoredDate: _.authored_date,
				url: _.web_url
			};
		});
	}

	_pullRequestIdCache: Map<
		string,
		{
			pullRequestNumber: number;
			name: string;
			owner: string;
		}
	> = new Map<
		string,
		{
			pullRequestNumber: number;
			name: string;
			owner: string;
		}
	>();

	async toggleMilestoneOnPullRequest(request: {
		pullRequestId: string;
		milestoneId: string;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const response = await this.restPut<{ name: string }, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}`,
				{
					milestone_id: request.milestoneId
				}
			);
			return {
				directives: [
					{
						type: "updatePullRequest",
						data: {
							milestone: response.body.milestone
						}
					}
				]
			};
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	async setWorkInProgressOnPullRequest(request: {
		pullRequestId: string;
		onOff: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const response = await this.mutate<any>(
				`mutation MergeRequestSetWip($projectPath: ID!, $iid: String!, $wip: Boolean!) {
					mergeRequestSetWip(input: {projectPath: $projectPath, iid: $iid, wip: $wip}) {
					  mergeRequest {
						title
						workInProgress
					  }
					}
				  }
				  `,
				{
					projectPath: projectFullPath,
					iid: iid,
					wip: request.onOff
				}
			);

			return {
				directives: [
					{
						type: "updatePullRequest",
						data: {
							workInProgress: response.mergeRequestSetWip.mergeRequest.workInProgress,
							title: response.mergeRequestSetWip.mergeRequest.title
						}
					}
				]
			};
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	async setLabelOnPullRequest(request: {
		pullRequestId: string;
		labelIds: string[];
		onOff: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const response = await this.mutate<any>(
				`mutation MergeRequestSetLabels($projectPath: ID!, $iid: String!, $labelIds: [LabelID!]!) {
					mergeRequestSetLabels(input: {projectPath: $projectPath, iid: $iid, labelIds: $labelIds}) {
					  mergeRequest {
						labels(last: 100) {
						  nodes {
							id
							color
							textColor
							title
						  }
						}
					  }
					}
				  }
				  `,
				{
					projectPath: projectFullPath,
					iid: iid,
					labelIds: request.labelIds
				}
			);

			return {
				directives: [
					{
						type: "setLabels",
						data: response.mergeRequestSetLabels.mergeRequest.labels
					}
				]
			};
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	async toggleReaction(request: {
		pullRequestId: string;
		subjectId: string;
		content: string;
		onOff: boolean;
		id?: string;
	}): Promise<Directives | undefined> {
		const parsed = JSON.parse(request.pullRequestId);
		request.pullRequestId = parsed.id;
		const projectFullPath = parsed.full.split("!")[0];
		const iid = parsed.full.split("!")[1];

		try {
			if (request.onOff) {
				const response = await this.restPost<
					{
						name: string;
					},
					any
				>(`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/award_emoji`, {
					name: request.content
				});
				return {
					directives: [
						{
							type: "addReaction",
							data: response.body
						}
					]
				};
			} else {
				if (!request.id) throw new Error("MissingId");

				// with DELETEs we don't get a JSON response
				const response = await this.restDelete<String>(
					`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/award_emoji/${
						request.id
					}`,
					{
						useRawResponse: true
					}
				);
				if (response.body === "") {
					return {
						directives: [
							{
								type: "removeReaction",
								data: {
									content: request.content,
									username: this._gitlabUsername
								}
							}
						]
					};
				}
			}
		} catch (err) {
			Logger.error(err);
			debugger;
		}
		return undefined;
	}

	async getPullRequestFilesChanged(request: {
		pullRequestId: string;
	}): Promise<FetchThirdPartyPullRequestFilesResponse[]> {
		// https://developer.github.com/v3/pulls/#list-pull-requests-files
		const changedFiles: FetchThirdPartyPullRequestFilesResponse[] = [];
		const parsed = JSON.parse(request.pullRequestId);
		request.pullRequestId = parsed.id;
		const projectFullPath = parsed.full.split("!")[0];
		const iid = parsed.full.split("!")[1];

		try {
			const url: string | undefined = `/projects/${encodeURIComponent(
				projectFullPath
			)}/merge_requests/${iid}/changes`;

			const apiResponse = await this.restGet<{
				diff_refs: {
					base_sha: string;
					head_sha: string;
					start_sha: string;
				};
				changes: {
					sha: string;
					old_path: string;
					new_path: string;
					diff?: string;
				}[];
			}>(url);
			const mappped: FetchThirdPartyPullRequestFilesResponse[] = apiResponse.body.changes.map(_ => {
				return {
					sha: _.sha,
					status: "",
					additions: 0,
					changes: 0,
					deletions: 0,
					filename: _.new_path,
					patch: _.diff,
					diffRefs: apiResponse.body.diff_refs
				};
			});
			changedFiles.push(...mappped);
		} catch (err) {
			Logger.error(err);
			debugger;
		}

		return changedFiles;
	}

	async mergePullRequest(request: {
		pullRequestId: string;
		message: string;
		deleteSourceBranch?: boolean;
		squashCommits?: boolean;
		includeMergeRequestDescription: boolean;
	}): Promise<Directives | undefined> {
		const { projectFullPath, iid } = this.parseId(request.pullRequestId);

		try {
			const response = await this.restPut<any, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/merge`,
				{
					merge_commit_message: request.message,
					squash: request.squashCommits,
					should_remove_source_branch: request.deleteSourceBranch
				}
			);
			// Logger.log(JSON.stringify(response));
			return {
				directives: [
					{
						type: "updatePullRequest",
						data: {
							merged: true,
							state: response.body.state,
							mergedAt: response.body.merged_at,
							updatedAt: response.body.updated_at
						}
					}
				]
			};
		} catch (ex) {
			Logger.warn(ex.message);
		}
		return undefined;
	}

	async createPullRequestInlineComment(request: {
		pullRequestId: string;
		text: string;
		sha?: string;
		leftSha: string;
		rightSha: string;
		filePath: string;
		startLine: number;
		position?: number;
		metadata?: any;
	}) {
		const result = await this.createCommitComment({
			...request,
			path: request.filePath,
			sha: request.sha || request.rightSha
		});
		return result;
	}

	async createCommitComment(request: {
		pullRequestId: string;
		// leftSha
		leftSha: string;
		// rightSha
		sha: string;
		text: string;
		path: string;
		startLine: number;
		// use endLine for multi-line comments
		endLine?: number;
		// used for old servers
		position?: number;
	}) {
		const parsed = JSON.parse(request.pullRequestId);
		const actualPullRequestId = parsed.id;
		const projectFullPath = parsed.full.split("!")[0];
		const iid = parsed.full.split("!")[1];

		const payload = {
			body: request.text,
			position: {
				base_sha: request.leftSha,
				head_sha: request.sha,
				start_sha: request.leftSha,
				position_type: "text",
				new_path: request.path,
				new_line: request.startLine
			}
		};

		const data = await this.restPost<any, any>(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/discussions`,
			payload
		);

		this._pullRequestCache.delete(actualPullRequestId);
		this.session.agent.sendNotification(DidChangePullRequestCommentsNotificationType, {
			pullRequestId: actualPullRequestId
		});

		return data.body;
	}

	public async togglePullRequestApproval(request: {
		pullRequestId: string;
		approve: boolean;
	}): Promise<Directives | undefined> {
		const parsed = JSON.parse(request.pullRequestId);
		const projectFullPath = parsed.full.split("!")[0];
		const iid = parsed.full.split("!")[1];

		let response;
		const type: any = request.approve ? "addApprovedBy" : "removeApprovedBy";

		// NOTE there's no graphql for these
		if (request.approve) {
			response = await this.restPost<any, any>(
				`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/approve`,
				{}
			);
		} else {
			try {
				response = await this.restPost<any, any>(
					`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/unapprove`,
					{}
				);
			} catch (ex) {
				// this will throw a 404 error if it's alreay been unapproved
				// but you can approve many times
				Logger.warn(ex.message);
			}
		}

		return {
			directives: [
				{
					type: type,
					data:
						response &&
						response.body.approved_by.map(
							(_: { user: { avatar_url: string; username: string; name: string } }) => {
								return {
									avatarUrl: _.user.avatar_url,
									username: _.user.username,
									name: _.user.name
								};
							}
						)
				}
			]
		};
	}

	private async _projectEvents(projectFullPath: string, iid: string) {
		const projectEvents = ((await this.restGet(
			`/projects/${encodeURIComponent(projectFullPath)}/events`
		))!.body as any[])
			// exclude the "comment" events as those exist in discussion/notes
			.filter(
				_ =>
					/*_.target_iid.toString() === iid && */ _.action_name !== "commented on" &&
					_.action_name !== "pushed to"
			)
			.map(_ => {
				return {
					type: "merge-request",
					author: _.author,
					action: _.action_name,
					createdAt: _.created_at,
					id: _.id,
					projectId: _.project_id,
					targetId: _.target_id,
					targetTitle: _.target_title,
					targetType: _.target_type
				};
			});
		return projectEvents;
	}

	private async _milestoneEvents(projectFullPath: string, iid: string) {
		const milestoneEvents = ((await this.restGet(
			`/projects/${encodeURIComponent(
				projectFullPath
			)}/merge_requests/${iid}/resource_milestone_events`
		))!.body as any[]).map(_ => {
			return {
				type: "milestone",
				createdAt: _.created_at,
				action: _.action,
				id: _.id,
				label: _.label,
				resourceType: _.resource_type,
				user: _.user
			};
		});
		return milestoneEvents;
	}

	private async _labelEvents(projectFullPath: string, iid: string) {
		const labelEvents = ((await this.restGet(
			`/projects/${encodeURIComponent(projectFullPath)}/merge_requests/${iid}/resource_label_events`
		))!.body as any[]).map(_ => {
			return {
				type: "label",
				createdAt: _.created_at,
				action: _.action,
				id: _.id,
				label: _.label,
				resourceType: _.resource_type,
				user: _.user
			};
		});
		return labelEvents;
	}
}

interface GitLabPullRequest {
	id: number;
	iid: number;
	number: number;
	title: string;
	web_url: string;
	state: string;
	target_branch: string;
	source_branch: string;
}

interface GitLabPullRequestComment {
	id: number;
	type: string;
	body: string;
	attachment?: any;
	author: GitLabPullRequestCommentAuthor;
	created_at: string;
	updated_at: string;
	system: boolean;
	noteable_id: number;
	noteable_type: string;
	position: GitLabPullRequestCommentPosition;
	resolvable: boolean;
	resolved: boolean;
	resolved_by?: string;
	noteable_iid: number;
}

interface GitLabPullRequestCommentAuthor {
	id: number;
	name: string;
	username: string;
	state: string;
	avatar_url: string;
	web_url: string;
}

interface GitLabPullRequestCommentPosition {
	base_sha: string;
	start_sha: string;
	head_sha: string;
	old_path: string;
	new_path: string;
	position_type: string;
	old_line?: number;
	new_line: number;
}

interface GitLabCreateMergeRequestRequest {
	title: string;
	source_branch: string;
	target_branch: string;
	description?: string;
}

interface GitLabCreateMergeRequestResponse {
	iid: string;
	title: string;
	web_url: string;
}

interface GitLabProjectInfoResponse {
	iid?: number;
	id?: number;
	default_branch: string;
}

interface GitLabMergeRequestInfoResponse {
	iid: number;
	web_url: string;
	source_branch: string;
	target_branch: string;
	references: {
		full: string;
	};
}
