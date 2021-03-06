import '../common/init/extensionContext';
import isEqual from 'lodash-es/isEqual';
import { ApiClient, SessionName } from 'synology-typescript-api';
import { getHostUrl, onStoredStateChange, NotificationSettings, updateStateShapeIfNecessary } from '../common/state';
import { notify } from '../common/apis/browserUtils';
import { setSharedObjects, isAddTaskMessage } from '../common/apis/messages';
import { addDownloadTaskAndPoll, pollTasks, clearCachedTasks } from '../common/apis/actions';
import { ALL_DOWNLOADABLE_PROTOCOLS, startsWithAnyProtocol } from '../common/apis/protocols';

const api = new ApiClient({});
const START_TIME = Date.now();

setSharedObjects({ api });

let finishedTaskIds: string[] | undefined;

let lastNotificationSettings: NotificationSettings | undefined;
let notificationInterval: number | undefined;

let showNonErrorNotifications: boolean = true;

updateStateShapeIfNecessary()
.then(() => {
  onStoredStateChange(storedState => {
    const didUpdateSettings = api.updateSettings({
      baseUrl: getHostUrl(storedState.connection),
      account: storedState.connection.username,
      passwd: storedState.connection.password,
      session: SessionName.DownloadStation
    });

    if (didUpdateSettings) {
      clearCachedTasks()
        .then(() => { pollTasks(api); });
    }

    if (!isEqual(storedState.notifications, lastNotificationSettings)) {
      lastNotificationSettings = storedState.notifications;
      clearInterval(notificationInterval!);
      if (lastNotificationSettings.enableCompletionNotifications) {
        notificationInterval = setInterval(
          () => { pollTasks(api); },
          lastNotificationSettings.completionPollingInterval * 1000) as any as number;
      }
    }

    showNonErrorNotifications = storedState.notifications.enableFeedbackNotifications;

    if (storedState.taskFetchFailureReason) {
      browser.browserAction.setIcon({
        path: {
          '16': 'icons/icon-16-disabled.png',
          '32': 'icons/icon-32-disabled.png',
          '64': 'icons/icon-64-disabled.png',
          '128': 'icons/icon-128-disabled.png',
          '256': 'icons/icon-256-disabled.png'
        }
      });

      browser.browserAction.setBadgeText({
        text: ''
      });

      browser.browserAction.setBadgeBackgroundColor({ color: [ 217, 0, 0, 255 ] });
    } else {
      browser.browserAction.setIcon({
        path: {
          '16': 'icons/icon-16.png',
          '32': 'icons/icon-32.png',
          '64': 'icons/icon-64.png',
          '128': 'icons/icon-128.png',
          '256': 'icons/icon-256.png'
        }
      });

      browser.browserAction.setBadgeText({
        text: storedState.tasks.length === 0 ? '' : storedState.tasks.length.toString()
      });

      browser.browserAction.setBadgeBackgroundColor({ color: [ 0, 217, 0, 255 ] });
    }

    if (storedState.tasksLastCompletedFetchTimestamp != null && storedState.tasksLastCompletedFetchTimestamp > START_TIME && storedState.taskFetchFailureReason == null) {
      const updatedFinishedTaskIds = storedState.tasks
        .filter(t => t.status === 'finished' || t.status === 'seeding')
        .map(t => t.id);
      if (finishedTaskIds != null) {
        const newlyFinishedTaskIds = updatedFinishedTaskIds.filter(id => finishedTaskIds!.indexOf(id) === -1);
        newlyFinishedTaskIds.forEach(id => {
          const task = storedState.tasks.filter(t => t.id === id)[0];
          if (storedState.notifications.enableCompletionNotifications) {
            notify(`${task.title}`, browser.i18n.getMessage('Download_finished'));
          }
        });
      }
      finishedTaskIds = (finishedTaskIds || []).concat(updatedFinishedTaskIds.filter(taskId => {
        return !finishedTaskIds || finishedTaskIds.indexOf(taskId) === -1;
      }));
    }
  });
});

browser.contextMenus.create({
  enabled: true,
  title: browser.i18n.getMessage('Download_with_DownloadStation'),
  contexts: [ 'link', 'audio', 'video', 'selection' ],
  onclick: (data) => {
    if (data.linkUrl) {
      addDownloadTaskAndPoll(api, showNonErrorNotifications, data.linkUrl)
    } else if (data.srcUrl) {
      addDownloadTaskAndPoll(api, showNonErrorNotifications, data.srcUrl);
    } else if (data.selectionText) {
      // The cheapest of checks. Actual invalid URLs will be caught later.
      const trimmedUrl = data.selectionText.trim();
      if (startsWithAnyProtocol(trimmedUrl, ALL_DOWNLOADABLE_PROTOCOLS)) {
        addDownloadTaskAndPoll(api, showNonErrorNotifications, data.selectionText);
      } else {
        notify(browser.i18n.getMessage('Failed_to_add_download'), browser.i18n.getMessage('Selected_text_is_not_a_valid_URL'), 'failure');
      }
    } else {
      notify(browser.i18n.getMessage('Failed_to_add_download'), browser.i18n.getMessage('URL_is_empty_or_missing'), 'failure');
    }
  }
});

browser.runtime.onMessage.addListener(message => {
  if (isAddTaskMessage(message)) {
    return addDownloadTaskAndPoll(api, showNonErrorNotifications, message.url);
  } else {
    console.error('received a message of unknown type', message);
    return undefined;
  }
});
