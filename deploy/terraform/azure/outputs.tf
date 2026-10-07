output "subscription_id" {
  value = var.subscription_id
}

output "resource_group_name" {
  value = azurerm_resource_group.ai_notes.name
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.ai_notes.name
}

output "acr_name" {
  value = azurerm_container_registry.ai_notes.name
}

output "acr_login_server" {
  value = azurerm_container_registry.ai_notes.login_server
}
