import React from "react";
import { Button, Card, Row, Col } from "react-bootstrap";
import { FormattedMessage } from "react-intl";
import * as GQL from "src/core/generated-graphql";
import { useToast } from "src/hooks/Toast";
import { useHistory } from "react-router-dom";
import { LoadingIndicator } from "src/components/Shared/LoadingIndicator";
import { SettingSection } from "./SettingSection";
import { StringSetting, BooleanSetting, ModalSetting } from "./Inputs";
import { useSettings } from "./context";
import { Icon } from "../Shared/Icon";
import { faCloudDownloadAlt, faCloudUploadAlt, faSync, faSearch } from "@fortawesome/free-solid-svg-icons";

export const SettingsAutomationPanel: React.FC = () => {
  const Toast = useToast();
  const history = useHistory();
  const { automation, loading, error, saveAutomation } = useSettings();

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
    <div className="automation-settings">
      <SettingSection headingID="Automation Dashboard">
        <p className="text-muted mb-4">
          Configure automated background tasks and cloud synchronization.
        </p>

        <Row className="mb-4">
          <Col md={6}>
            <Card className="automation-card h-100">
              <Card.Body>
                <div className="d-flex align-items-center mb-3">
                  <div className="automation-icon-wrapper bg-primary-soft mr-3">
                    <Icon icon={faSync} className="text-primary" />
                  </div>
                  <h5 className="mb-0">Startup Tasks</h5>
                </div>
                <BooleanSetting
                  id="automation-startup-scan"
                  headingID="Startup Scan"
                  subHeadingID="Automatically scan for new files when Stash starts."
                  checked={automation.startupScan ?? true}
                  onChange={(v) => saveAutomation({ startupScan: v })}
                />
                <BooleanSetting
                  id="automation-startup-identify"
                  headingID="Startup Identify"
                  subHeadingID="Automatically identify new scenes using scrapers on startup."
                  checked={automation.startupIdentify ?? true}
                  onChange={(v) => saveAutomation({ startupIdentify: v })}
                />
                <BooleanSetting
                  id="automation-startup-identify-process-organized"
                  headingID="Skip organized scenes"
                  subHeadingID="Skip scenes already marked as organized during startup identify."
                  checked={!automation.startupIdentifyProcessOrganized}
                  onChange={(v) =>
                    saveAutomation({ startupIdentifyProcessOrganized: !v })
                  }
                />
              </Card.Body>
            </Card>
          </Col>
          <Col md={6}>
            <Card className="automation-card h-100">
              <Card.Body>
                <div className="d-flex align-items-center mb-3">
                  <div className="automation-icon-wrapper bg-info-soft mr-3">
                    <Icon icon={faCloudDownloadAlt} className="text-info" />
                  </div>
                  <h5 className="mb-0">Cloud Sync</h5>
                </div>
                <BooleanSetting
                  id="automation-cloud-pull"
                  headingID="Cloud Pull"
                  subHeadingID="Automatically pull metadata updates from the cloud."
                  checked={automation.cloudPull ?? true}
                  onChange={(v) => saveAutomation({ cloudPull: v })}
                />
                <BooleanSetting
                  id="automation-cloud-push"
                  headingID="Cloud Push"
                  subHeadingID="Automatically push local metadata changes to the cloud."
                  checked={automation.cloudPush ?? true}
                  onChange={(v) => saveAutomation({ cloudPush: v })}
                />
              </Card.Body>
            </Card>
          </Col>
        </Row>

        <Card className="mb-4">
          <Card.Header>
            <h5 className="mb-0">Manual Cloud Actions</h5>
          </Card.Header>
          <Card.Body>
            <div className="d-flex">
              <Button variant="outline-primary" className="mr-2" onClick={onPull}>
                <Icon icon={faCloudDownloadAlt} className="mr-2" />
                Pull from Cloud Now
              </Button>
              <Button variant="outline-success" onClick={onPush}>
                <Icon icon={faCloudUploadAlt} className="mr-2" />
                Push to Cloud Now
              </Button>
            </div>
          </Card.Body>
        </Card>

        <SettingSection headingID="Cloud Configuration">
          <StringSetting
            id="cloud-sync-url"
            headingID="Supabase URL"
            value={automation.cloudSyncSupabaseURL ?? ""}
            onChange={(v) => saveAutomation({ cloudSyncSupabaseURL: v })}
          />

          <ModalSetting<string>
            id="cloud-sync-key"
            headingID="Supabase Key"
            value={automation.cloudSyncSupabaseKey ?? ""}
            onChange={(v) => saveAutomation({ cloudSyncSupabaseKey: v })}
            renderField={(value, setValue) => (
              <input
                className="form-control text-input"
                type="password"
                value={value ?? ""}
                onChange={(e) => setValue(e.currentTarget.value)}
              />
            )}
            renderValue={(value) => <span>{value ? "********" : ""}</span>}
          />

          <StringSetting
            id="cloud-sync-bucket"
            headingID="Supabase Bucket"
            value={automation.cloudSyncSupabaseBucket ?? ""}
            onChange={(v) => saveAutomation({ cloudSyncSupabaseBucket: v })}
            advanced
          />

          <BooleanSetting
            id="cloud-sync-auto-push"
            headingID="Auto-Push Daily"
            subHeadingID="Perform a full cloud sync every 24 hours."
            checked={automation.cloudSyncAutoPush ?? false}
            onChange={(v) => saveAutomation({ cloudSyncAutoPush: v })}
          />
        </SettingSection>
      </SettingSection>
    </div>
  );
};
