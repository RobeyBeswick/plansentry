import type { Config } from '../policy/config.js';
import { matchesAny } from '../findings.js';
import { SPEC_STATEFUL_TYPES } from './stateful-generated.js';

/** Stateful types the service spec doesn't flag yet. */
const EXTRA_STATEFUL = [
  'AWS::ECR::Repository',
  'AWS::Cognito::IdentityPool',
  'AWS::Timestream::Database',
  'AWS::Timestream::Table',
  'AWS::Cassandra::Table',
  'AWS::Cassandra::Keyspace',
  'AWS::MSK::Cluster',
  'AWS::MSK::ServerlessCluster',
  'AWS::MemoryDB::Cluster',
  'AWS::RDS::GlobalCluster',
  'AWS::S3Express::DirectoryBucket',
  'AWS::S3Tables::TableBucket',
  'AWS::Route53::HostedZone',
  'AWS::CertificateManager::Certificate',
  'AWS::DSQL::Cluster',
  'AWS::RedshiftServerless::Namespace',
  'AWS::DocDBElastic::Cluster',
];

export const CFN_STATEFUL = new Set<string>([...SPEC_STATEFUL_TYPES, ...EXTRA_STATEFUL]);

export const CFN_WARN_TYPES = new Set([
  'AWS::EKS::Cluster',
  'AWS::EC2::Instance',
  'AWS::EC2::VPC',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::CloudFront::Distribution',
  'AWS::ApiGateway::RestApi',
  'AWS::AppSync::GraphQLApi',
  'AWS::StepFunctions::StateMachine',
]);

/** Resource properties that protect against deletion when true. */
export const CFN_PROTECTION_PROPS = ['DeletionProtection', 'DeletionProtectionEnabled', 'DisableApiTermination', 'TerminationProtection'];

export function isCfnStateful(type: string, config: Config): boolean {
  if (matchesAny(type, config.statefulTypes.remove)) return false;
  return CFN_STATEFUL.has(type) || matchesAny(type, config.statefulTypes.add);
}
