/**
 * Terraform resource types whose deletion loses data, and the attributes that
 * guard them. Keep this list conservative: every entry here turns a delete
 * into something a human has to approve.
 */

export interface Protection {
  attr: string;
  /** True if this attribute value protects data from deletion. */
  protects: (value: unknown) => boolean;
  /** Human wording when the protection is off, e.g. "no final snapshot". */
  offLabel: string;
  onLabel: string;
}

const isTrue = (v: unknown) => v === true;
const isFalse = (v: unknown) => v === false;
const positive = (v: unknown) => typeof v === 'number' && v > 0;
const present = (v: unknown) => typeof v === 'string' && v.length > 0;

const deletionProtection: Protection = {
  attr: 'deletion_protection',
  protects: isTrue,
  onLabel: 'deletion_protection is on (the provider will refuse the delete)',
  offLabel: 'deletion_protection is off',
};
const skipFinalSnapshot: Protection = {
  attr: 'skip_final_snapshot',
  protects: isFalse,
  onLabel: 'a final snapshot will be taken',
  offLabel: 'skip_final_snapshot = true (no final snapshot)',
};
const forceDestroy: Protection = {
  attr: 'force_destroy',
  protects: isFalse,
  onLabel: 'force_destroy is off (delete fails if not empty)',
  offLabel: 'force_destroy = true (all contents are deleted with it)',
};

export const TERRAFORM_STATEFUL: Record<string, Protection[]> = {
  // AWS
  aws_db_instance: [deletionProtection, skipFinalSnapshot],
  aws_rds_cluster: [deletionProtection, skipFinalSnapshot],
  aws_rds_global_cluster: [deletionProtection],
  aws_docdb_cluster: [deletionProtection, skipFinalSnapshot],
  aws_neptune_cluster: [deletionProtection, skipFinalSnapshot],
  aws_redshift_cluster: [skipFinalSnapshot],
  aws_redshiftserverless_namespace: [],
  aws_s3_bucket: [forceDestroy],
  aws_s3_directory_bucket: [forceDestroy],
  aws_s3tables_table_bucket: [],
  aws_dynamodb_table: [
    {
      attr: 'deletion_protection_enabled',
      protects: isTrue,
      onLabel: 'deletion_protection_enabled is on (the provider will refuse the delete)',
      offLabel: 'deletion_protection_enabled is off',
    },
  ],
  aws_kms_key: [],
  aws_secretsmanager_secret: [
    {
      attr: 'recovery_window_in_days',
      protects: positive,
      onLabel: 'recoverable during the recovery window',
      offLabel: 'recovery_window_in_days = 0 (deleted immediately, unrecoverable)',
    },
  ],
  aws_ecr_repository: [
    {
      attr: 'force_delete',
      protects: isFalse,
      onLabel: 'force_delete is off (delete fails if images exist)',
      offLabel: 'force_delete = true (all images are deleted)',
    },
  ],
  aws_route53_zone: [forceDestroy],
  aws_cognito_user_pool: [
    {
      attr: 'deletion_protection',
      protects: (v) => v === 'ACTIVE',
      onLabel: 'deletion_protection is ACTIVE',
      offLabel: 'deletion_protection is not ACTIVE',
    },
  ],
  aws_backup_vault: [forceDestroy],
  aws_elasticache_replication_group: [
    { attr: 'final_snapshot_identifier', protects: present, onLabel: 'a final snapshot will be taken', offLabel: 'no final_snapshot_identifier' },
  ],
  aws_elasticache_cluster: [
    { attr: 'final_snapshot_identifier', protects: present, onLabel: 'a final snapshot will be taken', offLabel: 'no final_snapshot_identifier' },
  ],
  aws_memorydb_cluster: [
    { attr: 'final_snapshot_name', protects: present, onLabel: 'a final snapshot will be taken', offLabel: 'no final_snapshot_name' },
  ],
  aws_efs_file_system: [],
  aws_ebs_volume: [],
  aws_fsx_lustre_file_system: [],
  aws_fsx_ontap_file_system: [],
  aws_fsx_windows_file_system: [],
  aws_fsx_openzfs_file_system: [],
  aws_opensearch_domain: [],
  aws_elasticsearch_domain: [],
  aws_kinesis_stream: [],
  aws_msk_cluster: [],
  aws_msk_serverless_cluster: [],
  aws_qldb_ledger: [deletionProtection],
  aws_timestream_database: [],
  aws_timestream_table: [],
  aws_keyspaces_table: [],
  aws_dsql_cluster: [
    {
      attr: 'deletion_protection_enabled',
      protects: isTrue,
      onLabel: 'deletion_protection_enabled is on',
      offLabel: 'deletion_protection_enabled is off',
    },
  ],
  aws_cloudwatch_log_group: [],
  aws_cognito_identity_pool: [],
  aws_organizations_account: [],
  aws_acm_certificate: [],

  // Google Cloud
  google_sql_database_instance: [deletionProtection],
  google_sql_database: [],
  google_storage_bucket: [forceDestroy],
  google_container_cluster: [deletionProtection],
  google_bigquery_table: [deletionProtection],
  google_bigquery_dataset: [
    {
      attr: 'delete_contents_on_destroy',
      protects: isFalse,
      onLabel: 'delete fails if the dataset has tables',
      offLabel: 'delete_contents_on_destroy = true (all tables are deleted)',
    },
  ],
  google_spanner_instance: [],
  google_spanner_database: [
    { attr: 'deletion_protection', protects: isTrue, onLabel: 'deletion_protection is on', offLabel: 'deletion_protection is off' },
  ],
  google_alloydb_cluster: [
    {
      attr: 'deletion_protection',
      protects: isTrue,
      onLabel: 'deletion_protection is on',
      offLabel: 'deletion_protection is off',
    },
  ],
  google_compute_disk: [],
  google_redis_instance: [],
  google_filestore_instance: [],
  google_kms_crypto_key: [],
  google_secret_manager_secret: [],
  google_firestore_database: [
    {
      attr: 'deletion_policy',
      protects: (v) => v !== 'DELETE',
      onLabel: 'deletion_policy abandons the database',
      offLabel: 'deletion_policy = DELETE',
    },
  ],

  // Azure
  azurerm_storage_account: [],
  azurerm_mssql_server: [],
  azurerm_mssql_database: [],
  azurerm_postgresql_flexible_server: [],
  azurerm_mysql_flexible_server: [],
  azurerm_cosmosdb_account: [],
  azurerm_key_vault: [],
  azurerm_managed_disk: [],
  azurerm_redis_cache: [],
  // Deleting a resource group deletes everything in it, managed or not.
  azurerm_resource_group: [],
};

/** Types where a delete is worth a warning but not a hard stop. */
export const TERRAFORM_WARN_TYPES = new Set([
  'aws_sqs_queue',
  'aws_lb',
  'aws_alb',
  'aws_cloudfront_distribution',
  'aws_eks_cluster',
  'aws_instance',
  'aws_iam_role',
  'aws_vpc',
  'google_compute_instance',
  'azurerm_linux_virtual_machine',
  'azurerm_windows_virtual_machine',
  'azurerm_kubernetes_cluster',
]);

/** Name-based fallback for provider types we don't list explicitly. */
const STATEFUL_HINT =
  /(^|_)(db|database|sql|postgres(ql)?|mysql|mariadb|mongo(db)?|cosmosdb|redis|bucket|volume|disk|dataset|table|filesystem|file_system|vault|backup|ledger|warehouse)(_|$)/;

export function looksStateful(type: string): boolean {
  return STATEFUL_HINT.test(type);
}

/** Attributes whose weakening (protected → unprotected) is worth flagging on any type. */
export const GENERIC_PROTECTIONS: Protection[] = [
  deletionProtection,
  {
    attr: 'deletion_protection_enabled',
    protects: isTrue,
    onLabel: 'deletion_protection_enabled is on',
    offLabel: 'deletion_protection_enabled is off',
  },
  { attr: 'termination_protection', protects: isTrue, onLabel: 'termination protection on', offLabel: 'termination protection off' },
  { attr: 'disable_api_termination', protects: isTrue, onLabel: 'API termination disabled', offLabel: 'API termination allowed' },
  forceDestroy,
  skipFinalSnapshot,
];
