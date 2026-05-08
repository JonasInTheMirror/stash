import React from "react";
import { Button, Alert, Form } from "react-bootstrap";
import { FormattedMessage, useIntl } from "react-intl";
import * as GQL from "src/core/generated-graphql";
import { useToast } from "src/hooks/Toast";
import { useHistory } from "react-router-dom";
import { LoadingIndicator } from "src/components/Shared/LoadingIndicator";
import { SettingSection } from "./SettingSection";
import { StringSetting, BooleanSetting, ModalSetting } from "./Inputs";
import { useSettings } from "./context";

export const SettingsCloudSyncPanel: React.FC = () => {
  const Toast = useToast();
  const history = useHistory();
  const { general, loading, error, saveGeneral } = useSettings();

  const [mutateCloudPush] = GQL.useMetadataCloudPushMutation();
  const [mutateCloudPull] = GQL.useMetadataCloudPullMutation();

  if (error) return <h1>{error.message}</h1>;
  if (loading) return <LoadingIndicator />;

  async function onPush() {
    try {
      const result = await mutateCloudPush();
      if (result.data?.metadataCloudPush) {
        history.push("/settings?tab=tasks");
      }
    } catch (e) {
      Toast.error(e);
    }
  }

  async function onPull() {
    try {
      const result = await mutateCloudPull();
      if (result.data?.metadataCloudPull) {
        history.push("/settings?tab=tasks");
      }
    } catch (e) {
      Toast.error(e);
    }
  }

  return (
    <>
      <SettingSection headingID="config.cloud_sync.heading">
        <p className="text-muted">
          <FormattedMessage id="config.cloud_sync.description" />
        </p>

        <StringSetting
          id="cloud-sync-url"
          headingID="config.cloud_sync.supabase_url"
          value={general.cloudSyncSupabaseURL ?? ""}
          onChange={(v) => saveGeneral({ cloudSyncSupabaseURL: v })}
        />

        <ModalSetting<string>
          id="cloud-sync-key"
          headingID="config.cloud_sync.supabase_key"
          value={general.cloudSyncSupabaseKey ?? ""}
          onChange={(v) => saveGeneral({ cloudSyncSupabaseKey: v })}
          renderField={(value, setValue) => (
            <Form.Control
              className="text-input"
              type="password"
              value={value ?? ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setValue(e.currentTarget.value)
              }
            />
          )}
          renderValue={(value) => <span>{value ? "********" : ""}</span>}
        />

        <StringSetting
          id="cloud-sync-bucket"
          headingID="config.cloud_sync.supabase_bucket"
          value={general.cloudSyncSupabaseBucket ?? ""}
          onChange={(v) => saveGeneral({ cloudSyncSupabaseBucket: v })}
          subHeadingID="config.cloud_sync.supabase_bucket_description"
          advanced
        />

        <BooleanSetting
          id="cloud-sync-auto-push"
          headingID="config.cloud_sync.auto_push_heading"
          subHeadingID="config.cloud_sync.auto_push_description"
          checked={general.cloudSyncAutoPush ?? false}
          onChange={(v) => saveGeneral({ cloudSyncAutoPush: v })}
        />
      </SettingSection>

      <SettingSection headingID="config.cloud_sync.push_heading">
        <p>
          <FormattedMessage id="config.cloud_sync.push_description" />
        </p>
        <Button variant="primary" onClick={onPush}>
          <FormattedMessage id="config.cloud_sync.push_button" />
        </Button>
      </SettingSection>

      <SettingSection headingID="config.cloud_sync.pull_heading">
        <Alert variant="warning">
          <FormattedMessage id="config.cloud_sync.pull_warning" />
        </Alert>
        <p>
          <FormattedMessage id="config.cloud_sync.pull_description" />
        </p>
        <Button variant="danger" onClick={onPull}>
          <FormattedMessage id="config.cloud_sync.pull_button" />
        </Button>
      </SettingSection>
    </>
  );
};
