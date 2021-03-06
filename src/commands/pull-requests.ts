import { component, inject } from 'tsdi';
import * as vscode from 'vscode';

import { TokenCommand } from '../command';
import * as git from '../git';
import { showProgress } from '../helper';
import { MergeMethod } from '../provider/github';
import { PullRequest } from '../provider/pull-request';
import { StatusBarManager } from '../status-bar-manager';

abstract class PullRequestCommand extends TokenCommand {

  protected async selectPullRequest(): Promise<PullRequest | undefined> {
    const pullRequests = await this.githubManager.listPullRequests();
    const items = pullRequests.map(pullRequest => ({
      label: pullRequest.title,
      description: `#${pullRequest.number}`,
      pullRequest
    }));
    const selected = await vscode.window.showQuickPick(items, {
      matchOnDescription: true
    });
    return selected ? selected.pullRequest : undefined;
  }

  private async hasRemoteTrackingBranch(): Promise<boolean> {
    const localBranch = await git.getCurrentBranch(this.folder.uri.fsPath);
    if (!localBranch) {
      return false;
    }
    return Boolean(await git.getRemoteTrackingBranch(this.folder.uri.fsPath, localBranch));
  }

  protected async requireRemoteTrackingBranch(): Promise<boolean> {
    const hasBranch = await this.hasRemoteTrackingBranch();
    if (!hasBranch) {
      vscode.window.showWarningMessage(
        `Cannot create pull request without remote branch. `
        + `Please push your local branch before creating pull request.`);
    }
    return hasBranch;
  }

  protected async showPullRequestNotification(pullRequest: PullRequest): Promise<void> {
    const result = await vscode.window.showInformationMessage(
      `Successfully created #${pullRequest.number}`, 'Open on Github');
    if (result) {
      vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(pullRequest.url));
    }
  }

}

@component({eager: true})
export class BrowsePullRequest extends PullRequestCommand {

  public id = 'vscode-github.browserPullRequest';

  @showProgress
  protected async runWithToken(): Promise<void> {
    const selected = await this.selectPullRequest();
    if (selected) {
      vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(selected.url));
    }
  }

}

@component({eager: true})
export class BrowseSimpleRequest extends PullRequestCommand {

  public id = 'vscode-github.browserSimplePullRequest';

  @showProgress
  protected async runWithToken(): Promise<void> {
    const pullRequest = await this.githubManager.getPullRequestForCurrentBranch();
    if (pullRequest) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(pullRequest.url));
    } else {
      vscode.window.showInformationMessage('No pull request for current branch found');
    }
  }

}

@component({eager: true})
export class CheckoutPullRequest extends PullRequestCommand {

  public id = 'vscode-github.checkoutPullRequests';

  @inject
  private statusBarManager: StatusBarManager;

  @showProgress
  protected async runWithToken(): Promise<void> {
    const selected = await this.selectPullRequest();
    if (selected) {
      await vscode.commands.executeCommand('git.checkout', selected.sourceBranch);
      this.statusBarManager.updateStatus();
    }
  }

}

@component({eager: true})
export class CreateSimplePullRequest extends PullRequestCommand {

  public id = 'vscode-github.createSimplePullRequest';

  @inject
  private statusBarManager: StatusBarManager;

  @showProgress
  protected async runWithToken(progress: vscode.Progress<{ message?: string | undefined; }>): Promise<void> {
    progress.report({ message: `Check preconditions` });
    if (!this.requireRemoteTrackingBranch()) {
      return;
    }
    progress.report({ message: `Create pull requets` });
    const pullRequest = await this.githubManager.createPullRequest();
    if (pullRequest) {
      this.statusBarManager.updateStatus();
      this.showPullRequestNotification(pullRequest);
    }
  }

}

@component({eager: true})
export class CreatePullRequest extends PullRequestCommand {

  public id = 'vscode-github.createPullRequest';

  @inject
  private statusBarManager: StatusBarManager;

  @showProgress
  protected async runWithToken(progress: vscode.Progress<{ message?: string | undefined; }>): Promise<void> {
    progress.report({ message: `Check preconditions` });
    if (!this.requireRemoteTrackingBranch()) {
      return;
    }
    progress.report({message: `Gather data`});
    let [owner, repo] = await git.getGitProviderOwnerAndRepository(this.folder.uri.fsPath);
    const repository = await this.githubManager.getRepository();
    const items = [{
      label: repository.name,
      description: '',
      repo: repository as { defaultBranch: string }
    }];
    if (repository.parent) {
      items.push({
        label: repository.parent.name,
        description: '',
        repo: repository.parent as { defaultBranch: string }
      });
    }
    const selectedRepository = await vscode.window.showQuickPick(items,
      { placeHolder: 'Select a repository to create the pull request in' });
    if (!selectedRepository) {
      return;
    }
    [owner, repo] = selectedRepository.label.split('/');
    const branch = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      prompt: 'Select a branch to create the pull request for',
      value: selectedRepository.repo.defaultBranch
    });
    if (!branch) {
      return;
    }
    progress.report({ message: `Create pull request` });
    const pullRequest = await this.githubManager.createPullRequest({
      owner,
      repository: repo,
      branch
    });
    if (pullRequest) {
      this.statusBarManager.updateStatus();
      this.showPullRequestNotification(pullRequest);
    }
  }

}

@component({eager: true})
export class MergePullRequest extends PullRequestCommand {

  public id = 'vscode-github.mergePullRequest';

  @inject
  private statusBarManager: StatusBarManager;

  @showProgress
  private async getMergeMethdod(): Promise<MergeMethod | undefined> {
    const preferedMethod = vscode.workspace.getConfiguration('github').get<MergeMethod>('preferedMergeMethod');
    if (preferedMethod) {
      return preferedMethod;
    }
    const items: { label: string; description: string; method: MergeMethod; }[] = [];
    const enabledMethods = await this.githubManager.getEnabledMergeMethods();
    if (enabledMethods.has('merge')) {
      items.push({
        label: 'Create merge commit',
        description: '',
        method: 'merge'
      });
    }
    if (enabledMethods.has('squash')) {
      items.push({
        label: 'Squash and merge',
        description: '',
        method: 'squash'
      });
    }
    if (enabledMethods.has('rebase')) {
      items.push({
        label: 'Rebase and merge',
        description: '',
        method: 'rebase'
      });
    }
    const selected = await vscode.window.showQuickPick(items);
    return selected ? selected.method : undefined;
  }

  @showProgress
  protected async runWithToken(progress: vscode.Progress<{ message?: string | undefined; }>): Promise<void> {
    progress.report({ message: `Check preconditions` });
    const pullRequest = await this.githubManager.getPullRequestForCurrentBranch();
    if (pullRequest && pullRequest.mergeable) {
      const method = await this.getMergeMethdod();
      if (method) {
        progress.report({ message: `Merge pull request` });
        if (await this.githubManager.mergePullRequest(pullRequest, method)) {
          this.statusBarManager.updateStatus();
          vscode.window.showInformationMessage(`Successfully merged`);
        } else {
          vscode.window.showInformationMessage(`Merge failed for unknown reason`);
        }
      }
    } else {
      vscode.window.showWarningMessage(
        'Either no pull request for current brach, or the pull request is not mergable');
    }
  }

}
