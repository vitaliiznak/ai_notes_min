variable "subscription_id" {
  type        = string
  description = "Azure subscription. ./deploy/tf.sh azure sets this from the current az account."
}

variable "location" {
  type        = string
  description = "Azure region for the resource group, registry, and cluster."
  default     = "westeurope"
}

variable "resource_group_name" {
  type        = string
  description = "Resource group that holds the registry and the cluster."
  default     = "ai-notes"
}

variable "cluster_name" {
  type        = string
  description = "AKS cluster name."
  default     = "ai-notes"
}

variable "dns_prefix" {
  type        = string
  description = "Public DNS prefix for the API server. Must be unique in the region. The script derives one from the subscription."

  validation {
    condition     = can(regex("^[a-z0-9]([-a-z0-9]{0,52}[a-z0-9])?$", var.dns_prefix))
    error_message = "dns_prefix must be 1-54 characters of lowercase letters, numbers, and hyphens, and must start and end with a letter or number."
  }
}

variable "acr_name" {
  type        = string
  description = "Globally unique Container Registry name, 5-50 alphanumeric characters. The script derives one from the subscription."

  validation {
    condition     = can(regex("^[a-z0-9]{5,50}$", var.acr_name))
    error_message = "acr_name must be 5-50 lowercase letters and numbers."
  }
}

variable "node_count" {
  type        = number
  description = "Nodes in the single system pool. One node fits Postgres and the API."
  default     = 1

  validation {
    condition     = var.node_count >= 1
    error_message = "node_count must be at least 1."
  }
}

variable "node_vm_size" {
  type        = string
  description = "VM size for the system pool."
  default     = "Standard_D2s_v5"
}
